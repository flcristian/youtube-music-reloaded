#!/usr/bin/env node
/**
 * MCP server for YouTube Music Reloaded.
 *
 * Talks to the app's "MCP Bridge" plugin over http://127.0.0.1 using the
 * port and token the plugin writes to `mcp-bridge.json` in the app's data
 * folder (override the path with YTM_BRIDGE_FILE).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const connectionFile = () => {
  if (process.env.YTM_BRIDGE_FILE) return process.env.YTM_BRIDGE_FILE;
  const appData =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? process.env.APPDATA
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return join(appData, 'YouTube Music', 'mcp-bridge.json');
};

/** Call a bridge method; the connection file is re-read on every call. */
const call = async (method, params = {}) => {
  let connection;
  try {
    connection = JSON.parse(readFileSync(connectionFile(), 'utf8'));
  } catch {
    throw new Error(
      'YouTube Music Reloaded is not set up: start the app with the MCP Bridge plugin enabled.',
    );
  }
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${connection.port}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${connection.token}`,
      },
      body: JSON.stringify({ method, params }),
    });
  } catch {
    throw new Error('YouTube Music Reloaded is not running.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body.result;
};


/** YouTube's "Most replayed" graph for a song (public, no account needed). */
const replayGraph = async (videoId) => {
  const response = await fetch(
    'https://www.youtube.com/youtubei/v1/next?prettyPrint=false',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        context: {
          client: { clientName: 'WEB', clientVersion: '2.20251101.00.00', hl: 'en' },
        },
        videoId,
      }),
    },
  );
  if (!response.ok) return undefined;
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (
          key === 'macroMarkersListEntity' &&
          value?.markersList?.markerType === 'MARKER_TYPE_HEATMAP'
        ) {
          found.push(value.markersList.markers);
        } else walk(value);
      }
    }
  };
  walk(await response.json());
  return found[0]?.map((marker) => ({
    at: Number(marker.startMillis) / 1000,
    value: marker.intensityScoreNormalized,
  }));
};

/** Listeners always start at 0:00 and drop off; ignore that part. */
const INTRO = 15;
const STEP = 5;

/**
 * The best `seconds`-long part of a song: the window with the most
 * rewatching, after removing the overall drop-off over the song (so
 * choruses and solos win wherever they are). Falls back to the middle.
 */
const bestPart = async (videoId, seconds) => {
  const details = await call('song_details', { videoId });
  const length = Math.floor(details.length);
  if (length <= seconds + 20) {
    return { start: 0, end: length, length, method: 'whole song (shorter than the part)' };
  }
  const graph = await replayGraph(videoId).catch(() => undefined);
  const body = graph?.filter((point) => point.at >= INTRO) ?? [];
  if (body.length < 10) {
    const start = Math.max(INTRO, Math.round(length * 0.45 - seconds / 2));
    return { start, end: Math.min(length, start + seconds), length, method: 'middle (no replay data)' };
  }
  // Linear fit of the replay curve = the drop-off; keep what's above it.
  const meanX = body.reduce((sum, p) => sum + p.at, 0) / body.length;
  const meanY = body.reduce((sum, p) => sum + p.value, 0) / body.length;
  const spread = body.reduce((sum, p) => sum + (p.at - meanX) ** 2, 0) || 1;
  const slope =
    body.reduce((sum, p) => sum + (p.at - meanX) * (p.value - meanY), 0) / spread;
  const above = body.map((p) => ({
    at: p.at,
    value: p.value - (meanY + slope * (p.at - meanX)),
  }));
  let best = { start: INTRO, score: -Infinity };
  for (let start = INTRO; start + seconds <= length - 4; start += STEP) {
    const score = above
      .filter((p) => p.at >= start && p.at < start + seconds)
      .reduce((sum, p) => sum + p.value, 0);
    if (score > best.score) best = { start, score };
  }
  const peak = above.reduce((a, b) => (b.value > a.value ? b : a));
  return {
    start: best.start,
    end: Math.min(length, best.start + seconds),
    length,
    method: 'most replayed',
    peakAt: Math.round(peak.at),
  };
};

const server = new McpServer({
  name: 'youtube-music-reloaded',
  version: '1.0.0',
});

const tool = (name, description, shape, method, map = (args) => args) =>
  server.tool(name, description, shape, async (args) => {
    try {
      const result = await call(method, map(args ?? {}));
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(err.message ?? err) }],
      };
    }
  });

const part = {
  videoId: z.string().describe('YouTube Music video id'),
  start: z
    .number()
    .min(0)
    .optional()
    .describe('Start playing at this second (default: from the beginning)'),
  end: z
    .number()
    .optional()
    .describe(
      'Stop at this second and crossfade into the next song (default: song end)',
    ),
};

tool(
  'now_playing',
  'The song playing now: id, title, artist, position/duration (seconds), paused, volume.',
  {},
  'now_playing',
);
tool(
  'get_queue',
  'The play queue starting at the current song (offset 0 = current), paginated.',
  {
    offset: z.number().int().min(0).optional().describe('Items after the current song to skip'),
    limit: z.number().int().min(1).max(200).optional().describe('Max items (default 25)'),
  },
  'get_queue',
);
tool(
  'search_songs',
  'Find songs by name and/or artist. `sources` picks where: "global" (all of YouTube Music, default), "liked" (liked songs), or playlist names/ids from the library (e.g. ["liked", "best ruski"]). Library sources are filtered locally; use offset/limit to page through them.',
  {
    query: z.string().optional().describe('Song name / any text to match'),
    artist: z.string().optional().describe('Only songs by this artist (e.g. "Miyagi")'),
    sources: z
      .array(z.string())
      .optional()
      .describe('Where to search: "global", "liked", playlist names or ids (default ["global"])'),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
    next: z.string().optional().describe('More global results (token from a previous global-only search)'),
  },
  'search_songs',
);
tool(
  'search_artists',
  'Search YouTube Music for artists (id, name, details). Pass `next` for more.',
  {
    query: z.string().optional().describe('Artist name (required unless `next` is given)'),
    next: z.string().optional().describe('Pagination token from a previous call'),
  },
  'search_artists',
);
tool(
  'get_artist_songs',
  "An artist's songs (their full songs list), by artist name (best match) or id, one page at a time. Pass `next` from the previous page to continue.",
  {
    artist: z.string().optional().describe('Artist name, e.g. "Miyagi"'),
    artistId: z.string().optional().describe('Artist id from search_artists (UC…)'),
    next: z.string().optional().describe('Pagination token from a previous page'),
  },
  'get_artist_songs',
);
tool(
  'list_playlists',
  "The user's library playlists (id, title, details). Liked songs are playlist id \"LM\".",
  { next: z.string().optional().describe('Pagination token from a previous call') },
  'list_playlists',
);
tool(
  'get_playlist_songs',
  'Songs in a playlist, one page at a time. Pass `next` from the previous page to continue.',
  {
    playlistId: z.string().optional().describe('Playlist id (e.g. "LM" for liked songs); required unless `next` is given'),
    next: z.string().optional().describe('Pagination token from a previous page'),
  },
  'get_playlist_songs',
);
tool(
  'song_details',
  'Title, length (seconds) and cover URL of any song.',
  { videoId: z.string() },
  'song_details',
);
tool(
  'get_waveform',
  'Loudness over the whole song (0–1 per point, evenly spaced) to find choruses/drops. Songs not played recently take a few seconds.',
  {
    videoId: z.string(),
    points: z.number().int().min(10).max(500).optional().describe('Number of points (default 100)'),
  },
  'get_waveform',
);
tool(
  'play',
  'Play a song now, crossfading from the current one. Optionally only a part of it (start/end in seconds).',
  part,
  'play',
);
tool(
  'play_next',
  'Insert a song right after the current one. Optionally only a part of it: when it comes up it starts at `start` and crossfades out at `end`.',
  part,
  'enqueue',
  (args) => ({ ...args, position: 'next' }),
);
tool(
  'add_to_queue',
  'Add a song to the end of the queue, optionally only a part of it (start/end in seconds).',
  part,
  'enqueue',
  (args) => ({ ...args, position: 'end' }),
);
tool('next', 'Skip to the next song (crossfades).', {}, 'next');
tool('previous', 'Previous song / restart the current one.', {}, 'previous');
tool('pause', 'Pause playback.', {}, 'pause');
tool('resume', 'Resume playback.', {}, 'resume');
tool(
  'seek',
  'Jump to a position in the current song.',
  { seconds: z.number().min(0) },
  'seek',
);
tool(
  'set_volume',
  'Set the player volume (0–100).',
  { volume: z.number().min(0).max(100) },
  'set_volume',
);
tool(
  'get_crossfade',
  'Current crossfade settings (auto/manual/"Play from" durations in seconds, curve).',
  {},
  'get_crossfade',
);
tool(
  'set_crossfade',
  'Change crossfade settings. Durations are seconds (0.5–20).',
  {
    autoEnabled: z.boolean().optional().describe('Crossfade at the end of a song'),
    autoDuration: z.number().optional(),
    manualEnabled: z.boolean().optional().describe('Crossfade on manual song changes'),
    manualDuration: z.number().optional(),
    jumpDuration: z.number().optional().describe('Crossfade for play with a start time'),
    curve: z.enum(['equal-power', 'linear', 'steep']).optional(),
  },
  'set_crossfade',
);

server.tool(
  'get_best_part',
  "The best part of a song to play: the window of `seconds` that listeners rewatch most on YouTube (ignoring the usual drop-off, so choruses/solos win anywhere in the song). Falls back to the middle without data. Use the returned start/end with play/play_next/add_to_queue.",
  {
    videoId: z.string(),
    seconds: z.number().min(10).max(600).optional().describe('Length of the part (default 120)'),
  },
  async ({ videoId, seconds = 120 }) => {
    try {
      const part = await bestPart(videoId, seconds);
      return { content: [{ type: 'text', text: JSON.stringify(part, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: String(err.message ?? err) }] };
    }
  },
);

await server.connect(new StdioServerTransport());

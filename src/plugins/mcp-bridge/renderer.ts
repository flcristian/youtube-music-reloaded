import { fetchDetails } from '@/plugins/seamless-crossfade/play-from';
import {
  getDjFeatures,
  type QueuePosition,
} from '@/plugins/utils/renderer/dj-registry';
import {
  innertube,
  type PlaylistSummary,
  type Track,
  parseArtistPage,
  parseArtists,
  parseContinuation,
  parsePlaylists,
  parseTracks,
} from '@/plugins/utils/renderer/innertube';
import { loadPeaks } from '@/plugins/waveform-seekbar/peaks';
import { createRenderer } from '@/utils';

import {
  type BridgeRequest,
  type BridgeResponse,
  REQUEST_CHANNEL,
  RESPONSE_CHANNEL,
} from './protocol';

import type { MusicPlayer } from '@/types/music-player';

/** "Songs" filter for search. */
const SONGS_FILTER = 'EgWKAQIIAWoKEAkQBRAKEAMQBA==';
/** "Artists" filter for search. */
const ARTISTS_FILTER = 'EgWKAQIgAWoKEAkQBRAKEAMQBA==';

/** Case- and diacritics-insensitive text for matching. */
const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
const includes = (haystack: string, needle: string) =>
  normalize(haystack).includes(normalize(needle));

/** Playlist pages read per playlist at most (≈100 songs each). */
const MAX_PAGES = 60;
const CACHE_TIME = 5 * 60_000;
const playlistCache = new Map<string, { at: number; tracks: Track[] }>();

/** Every song in a playlist (cached for a few minutes). */
const allPlaylistTracks = async (playlistId: string) => {
  const cached = playlistCache.get(playlistId);
  if (cached && Date.now() - cached.at < CACHE_TIME) return cached.tracks;
  const tracks: Track[] = [];
  let json = await innertube('browse', { browseId: `VL${playlistId}` });
  for (let page = 0; page < MAX_PAGES; page++) {
    tracks.push(...parseTracks(json));
    const next = parseContinuation(json);
    if (!next) break;
    json = await innertube('browse', { continuation: next });
  }
  playlistCache.set(playlistId, { at: Date.now(), tracks });
  return tracks;
};

/** All of the user's library playlists. */
const allPlaylists = async () => {
  const playlists: PlaylistSummary[] = [];
  let json = await innertube('browse', { browseId: 'FEmusic_liked_playlists' });
  for (let page = 0; page < 20; page++) {
    playlists.push(...parsePlaylists(json));
    const next = parseContinuation(json);
    if (!next) break;
    json = await innertube('browse', { continuation: next });
  }
  return playlists;
};

/** "liked", a playlist name (best match) or a playlist id. */
const resolvePlaylist = async (source: string) => {
  const wanted = normalize(source);
  if (['liked', 'liked songs', 'lm'].includes(wanted)) {
    return { playlistId: 'LM', title: 'Liked songs' };
  }
  const playlists = await allPlaylists();
  const found =
    playlists.find((it) => normalize(it.title) === wanted) ??
    playlists.find((it) => normalize(it.title).includes(wanted)) ??
    playlists.find((it) => it.playlistId === source.replace(/^VL/, ''));
  if (found) return found;
  if (/^(PL|OLAK|RD|VL)/.test(source)) {
    return { playlistId: source.replace(/^VL/, ''), title: source };
  }
  throw new Error(`No playlist named "${source}" in your library`);
};

const searchArtists = async (query: string) =>
  parseArtists(await innertube('search', { query, params: ARTISTS_FILTER }));

type Params = Record<string, unknown>;

const str = (params: Params, name: string) => {
  const value = params[name];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Missing "${name}"`);
  }
  return value;
};
const optStr = (params: Params, name: string) => {
  const value = params[name];
  return typeof value === 'string' && value ? value : undefined;
};
const optNum = (params: Params, name: string) => {
  const value = params[name];
  return typeof value === 'number' ? value : undefined;
};

const features = () => {
  const dj = getDjFeatures();
  if (!dj) throw new Error('Seamless Crossfade plugin is not running');
  return dj;
};

const interval = (params: Params) => {
  const start = Math.max(0, optNum(params, 'start') ?? 0);
  const end = optNum(params, 'end');
  if (end !== undefined && end <= start) {
    throw new Error('"end" must be after "start"');
  }
  return { start, end };
};

const clickButton = (selector: string) => {
  const button = document.querySelector<HTMLElement>(selector);
  if (!button) throw new Error(`Player button not found: ${selector}`);
  button.click();
};

type QueueElement = HTMLElement & {
  data?: {
    videoId?: string;
    title?: unknown;
    shortBylineText?: unknown;
    lengthText?: unknown;
  };
};

const text = (value: unknown) => {
  const node = value as
    | { runs?: { text?: string }[]; simpleText?: string }
    | undefined;
  return (
    node?.runs?.map((run) => run.text ?? '').join('') ?? node?.simpleText ?? ''
  );
};

const createMethods = (api: MusicPlayer) => ({
  now_playing: () => {
    const data = api.getVideoData();
    const video = document.querySelector('video');
    return {
      videoId: data?.video_id,
      title: data?.title,
      artist: data?.author,
      position: Math.round(api.getCurrentTime() * 10) / 10,
      duration: Math.round(api.getDuration() * 10) / 10,
      paused: video?.paused ?? true,
      volume: api.getVolume(),
      muted: api.isMuted(),
    };
  },

  get_queue: (params: Params) => {
    const offset = Math.max(0, optNum(params, 'offset') ?? 0);
    const limit = Math.min(200, Math.max(1, optNum(params, 'limit') ?? 25));
    const playing = api.getVideoData()?.video_id;
    // A row can hold a song and its music video version ("counterpart");
    // only the primary one counts as a queue entry.
    const items = [
      ...document.querySelectorAll<QueueElement>('ytmusic-player-queue-item'),
    ].filter((item) => item.parentElement?.id !== 'counterpart-renderer');
    const versions = (item: QueueElement) => [
      item,
      ...(item
        .closest('ytmusic-playlist-panel-video-wrapper-renderer')
        ?.querySelectorAll<QueueElement>(
          '#counterpart-renderer ytmusic-player-queue-item',
        ) ?? []),
    ];
    const current = items.findIndex((item) =>
      versions(item).some(
        (version) =>
          version.hasAttribute('selected') && version.data?.videoId === playing,
      ),
    );
    const from = (current >= 0 ? current : 0) + offset;
    return {
      currentIndex: current,
      total: items.length,
      items: items.slice(from, from + limit).map((item, i) => ({
        index: from + i,
        current: from + i === current,
        videoId: item.data?.videoId,
        title: text(item.data?.title),
        artist: text(item.data?.shortBylineText),
        duration: text(item.data?.lengthText),
      })),
    };
  },

  /**
   * Find songs by name and/or artist in any mix of sources: "global" (all
   * of YouTube Music), "liked" (liked songs) and playlists by name or id.
   */
  search_songs: async (params: Params) => {
    const query = optStr(params, 'query');
    const artist = optStr(params, 'artist');
    const next = optStr(params, 'next');
    const sources = Array.isArray(params.sources)
      ? params.sources.filter((it): it is string => typeof it === 'string')
      : ['global'];
    if (next) {
      const json = await innertube('search', { continuation: next });
      return { tracks: parseTracks(json), next: parseContinuation(json) };
    }
    if (!query && !artist) throw new Error('Give a "query" and/or "artist"');

    const matches = (track: Track) =>
      (!query ||
        includes(track.title, query) ||
        includes(track.subtitle, query)) &&
      (!artist || includes(track.subtitle, artist));

    const results: (Track & { source: string })[] = [];
    const seen = new Set<string>();
    const add = (tracks: Track[], source: string) => {
      for (const track of tracks) {
        if (seen.has(track.videoId) || !matches(track)) continue;
        seen.add(track.videoId);
        results.push({ ...track, source });
      }
    };
    const resolved: string[] = [];
    let globalNext: string | undefined;
    for (const source of sources) {
      if (normalize(source) === 'global') {
        const json = await innertube('search', {
          query: [query, artist].filter(Boolean).join(' '),
          params: SONGS_FILTER,
        });
        add(parseTracks(json), 'global');
        globalNext = parseContinuation(json);
        resolved.push('global');
        continue;
      }
      const playlist = await resolvePlaylist(source);
      add(await allPlaylistTracks(playlist.playlistId), playlist.title);
      resolved.push(`${playlist.title} (${playlist.playlistId})`);
    }

    const offset = Math.max(0, optNum(params, 'offset') ?? 0);
    const limit = Math.min(200, Math.max(1, optNum(params, 'limit') ?? 50));
    return {
      sources: resolved,
      total: results.length,
      tracks: results.slice(offset, offset + limit),
      // More global results (only when searching "global" alone).
      next: sources.length === 1 ? globalNext : undefined,
    };
  },

  search_artists: async (params: Params) => {
    const next = optStr(params, 'next');
    const json = next
      ? await innertube('search', { continuation: next })
      : await innertube('search', {
          query: str(params, 'query'),
          params: ARTISTS_FILTER,
        });
    return { artists: parseArtists(json), next: parseContinuation(json) };
  },

  /**
   * An artist's songs (their full "Songs" list when the artist page has
   * one), by artist id or by name (best match from search). Paginated.
   */
  get_artist_songs: async (params: Params) => {
    const next = optStr(params, 'next');
    if (next) {
      const json = await innertube('browse', { continuation: next });
      return { tracks: parseTracks(json), next: parseContinuation(json) };
    }
    let artistId = optStr(params, 'artistId');
    if (!artistId) {
      const name = str(params, 'artist');
      const found = await searchArtists(name);
      const exact = found.find(
        (artist) => artist.name.toLowerCase() === name.toLowerCase(),
      );
      artistId = (exact ?? found[0])?.artistId;
      if (!artistId) throw new Error(`No artist found for "${name}"`);
    }
    const page = parseArtistPage(
      await innertube('browse', { browseId: artistId }),
    );
    const artist = { artistId, name: page.name };
    if (!page.allSongs) {
      return { artist, tracks: page.tracks, next: undefined };
    }
    const json = await innertube('browse', page.allSongs);
    return {
      artist,
      tracks: parseTracks(json),
      next: parseContinuation(json),
    };
  },

  list_playlists: async (params: Params) => {
    const next = optStr(params, 'next');
    const json = next
      ? await innertube('browse', { continuation: next })
      : await innertube('browse', { browseId: 'FEmusic_liked_playlists' });
    return { playlists: parsePlaylists(json), next: parseContinuation(json) };
  },

  get_playlist_songs: async (params: Params) => {
    const next = optStr(params, 'next');
    const json = next
      ? await innertube('browse', { continuation: next })
      : await innertube('browse', {
          browseId: `VL${str(params, 'playlistId').replace(/^VL/, '')}`,
        });
    return { tracks: parseTracks(json), next: parseContinuation(json) };
  },

  song_details: async (params: Params) => fetchDetails(str(params, 'videoId')),

  get_waveform: async (params: Params) => {
    const videoId = str(params, 'videoId');
    const points = Math.min(500, Math.max(10, optNum(params, 'points') ?? 100));
    const [peaks, details] = await Promise.all([
      loadPeaks(videoId),
      fetchDetails(videoId),
    ]);
    if (!peaks) throw new Error('Waveform not available for this song');
    const values: number[] = [];
    for (let i = 0; i < points; i++) {
      const from = Math.floor((i / points) * peaks.length);
      const to = Math.max(
        from + 1,
        Math.floor(((i + 1) / points) * peaks.length),
      );
      let level = 0;
      for (let p = from; p < to; p++) level = Math.max(level, peaks[p]);
      values.push(Math.round(level * 100) / 100);
    }
    return {
      duration: details.length,
      secondsPerPoint: details.length / points,
      loudness: values,
    };
  },

  play: (params: Params) => {
    features().play(str(params, 'videoId'), interval(params));
    return { ok: true };
  },

  enqueue: (params: Params) => {
    const position: QueuePosition = params.position === 'end' ? 'end' : 'next';
    features().enqueue(str(params, 'videoId'), interval(params), position);
    return { ok: true };
  },

  next: () => {
    clickButton('.next-button');
    return { ok: true };
  },
  previous: () => {
    clickButton('.previous-button');
    return { ok: true };
  },
  pause: () => {
    api.pauseVideo();
    return { ok: true };
  },
  resume: () => {
    api.playVideo();
    return { ok: true };
  },
  seek: (params: Params) => {
    const seconds = optNum(params, 'seconds');
    if (seconds === undefined) throw new Error('Missing "seconds"');
    api.seekTo(seconds);
    return { ok: true };
  },
  set_volume: (params: Params) => {
    const volume = optNum(params, 'volume');
    if (volume === undefined) throw new Error('Missing "volume"');
    api.setVolume(Math.min(100, Math.max(0, Math.round(volume))));
    return { ok: true };
  },

  get_crossfade: () => features().getCrossfadeConfig(),
  set_crossfade: (params: Params) => {
    const changes: Record<string, unknown> = {};
    for (const key of ['autoEnabled', 'manualEnabled'] as const) {
      if (typeof params[key] === 'boolean') changes[key] = params[key];
    }
    for (const key of [
      'autoDuration',
      'manualDuration',
      'jumpDuration',
    ] as const) {
      const value = optNum(params, key);
      if (value !== undefined)
        changes[key] = Math.min(20, Math.max(0.5, value));
    }
    if (
      params.curve === 'equal-power' ||
      params.curve === 'linear' ||
      params.curve === 'steep' ||
      params.curve === 'exponential-out'
    ) {
      changes.curve = params.curve;
    }
    features().setCrossfadeConfig(changes);
    return features().getCrossfadeConfig();
  },
});

let methods: ReturnType<typeof createMethods> | undefined;

export const renderer = createRenderer({
  start({ ipc }) {
    ipc.on(REQUEST_CHANNEL, (request: BridgeRequest) => {
      const respond = (response: Omit<BridgeResponse, 'id'>) =>
        ipc.send(RESPONSE_CHANNEL, { id: request.id, ...response });
      const method = methods?.[request.method as keyof typeof methods] as
        | ((params: Params) => unknown)
        | undefined;
      if (!methods) {
        respond({ error: 'The player is not ready yet' });
        return;
      }
      if (!method) {
        respond({ error: `Unknown method: ${request.method}` });
        return;
      }
      Promise.resolve()
        .then(() => method(request.params ?? {}))
        .then((result) => respond({ result }))
        .catch((err: unknown) =>
          respond({ error: err instanceof Error ? err.message : String(err) }),
        );
    });
  },
  onPlayerApiReady(api) {
    methods = createMethods(api);
  },
  stop({ ipc }) {
    ipc.removeAllListeners(REQUEST_CHANNEL);
    methods = undefined;
  },
});

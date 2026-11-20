/**
 * When a song is sung, and by whom: the time spans of its timed lyrics
 * lines (YouTube Music's own lyrics; songs with plain lyrics only have
 * none), each matched to who sings that part on Genius ("[Verse 2: …]").
 */
import { LyricsGenius } from '@/plugins/synced-lyrics/providers/LyricsGenius';
import { YTMusic } from '@/plugins/synced-lyrics/providers/YTMusic';

/** A sung span, in song seconds. */
export interface Sung {
  start: number;
  end: number;
  /** Who sings it (0, 1, …: in order of first appearance; 0 if unknown). */
  voice?: number;
}

const provider = new YTMusic();
const genius = new LyricsGenius();
const cache = new Map<string, Promise<Sung[]>>();

/** Lowercase words only, for comparing lines. */
const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** How alike two lines are (shared words, 0 to 1). */
const likeness = (a: string[], b: string[]) => {
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  const shared = a.filter((word) => set.has(word)).length;
  return shared / Math.max(a.length, b.length);
};

/** A line on Genius and who sings it ('' : not said). */
interface Credited {
  words: string[];
  singers: string;
}

/** Genius' lines with the singers of their section. */
const creditedLines = (lyrics: string): Credited[] => {
  const lines: Credited[] = [];
  let singers = '';
  let started = false;
  for (const raw of lyrics.split('\n')) {
    const line = raw.trim();
    const header = /^\[([^\]]*)\]$/.exec(line);
    if (header) {
      started = true;
      const named = header[1].split(':')[1];
      singers = named ? named.trim().toLowerCase() : '';
      continue;
    }
    if (!started || !line) continue;
    lines.push({ words: words(line), singers });
  }
  return lines;
};

/** How far ahead (lines) a timed line is looked for on Genius. */
const REACH = 12;
const MIN_LIKENESS = 0.5;

/** Who sings each timed line (voice numbers), matched in order. */
const creditLines = (texts: string[], lyrics: string) => {
  const credited = creditedLines(lyrics);
  // Without named singers there's nothing to tell apart.
  if (!credited.some((line) => line.singers)) return undefined;
  const voices = new Map<string, number>();
  const voiceOf = (singers: string) => {
    if (!singers) return 0;
    if (!voices.has(singers)) voices.set(singers, voices.size);
    return voices.get(singers)!;
  };
  // Unnamed sections are the main artist's: the first one named.
  const main = credited.find((line) => line.singers)!.singers;
  let at = 0;
  let previous = voiceOf(main);
  return texts.map((text) => {
    const line = words(text);
    let best = -1;
    let bestLikeness = MIN_LIKENESS;
    for (let i = at; i < Math.min(credited.length, at + REACH); i++) {
      const value = likeness(line, credited[i].words);
      if (value > bestLikeness) {
        bestLikeness = value;
        best = i;
      }
    }
    if (best >= 0) {
      at = best + 1;
      previous = voiceOf(credited[best].singers || main);
    }
    return previous;
  });
};

export const loadSung = (videoId: string, title = '', artist = '') => {
  let sung = cache.get(videoId);
  if (!sung) {
    sung = provider
      .search({ videoId, title, artist, songDuration: 0 })
      .then(async (result) => {
        const lines = (result?.lines ?? []).filter(
          (line) => line.text.trim() && line.duration > 0,
        );
        if (!lines.length) return [];
        const credits = await genius
          .search({ videoId, title, artist, songDuration: 0 })
          .then((found) =>
            found?.lyrics
              ? creditLines(
                  lines.map((line) => line.text),
                  found.lyrics,
                )
              : undefined,
          )
          .catch(() => undefined);
        return lines.map((line, i) => ({
          start: line.timeInMs / 1000,
          end: (line.timeInMs + line.duration) / 1000,
          voice: credits?.[i] ?? 0,
        }));
      })
      .catch(() => []);
    // A failed lookup is tried again next time.
    sung.then((spans) => {
      if (!spans.length) cache.delete(videoId);
    });
    cache.set(videoId, sung);
  }
  return sung;
};

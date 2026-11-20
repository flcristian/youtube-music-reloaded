/**
 * Finds a song's drop: the first big lift in energy (on a bar start,
 * preferably a phrase start), where the song "really starts". Used to have
 * the next song's drop land as a transition ends.
 */
import { rangeLoudness } from '@/plugins/waveform-seekbar/loudness';
import {
  BAR,
  marksBetween,
  PHRASE,
  type Tempo,
} from '@/plugins/waveform-seekbar/tempo';

/** Where to look for it (song seconds). */
const SEARCH_FROM = 8;
const SEARCH_TO = 120;
/** It's this much louder (dB) than the beats before it… */
const MIN_LIFT = 3;
/** …and close to the song's full loudness (within this many dB). */
const NEAR_FULL = 2;
/** Beats compared before and after. */
const WINDOW_BEATS = 8;
/** A phrase start counts as this many dB more lift. */
const PHRASE_BONUS = 1.5;
/** Bars and phrases are worked out per stretch this long (seconds). */
const STRETCH = 16;

/** Marks every `every` beats from `from` to `to`, stretch by stretch. */
const marks = (tempo: Tempo, every: typeof BAR | typeof PHRASE) => {
  const times: number[] = [];
  for (let from = SEARCH_FROM; from < SEARCH_TO; from += STRETCH) {
    times.push(...marksBetween(tempo, from, from + STRETCH, every));
  }
  return times;
};

export const findDrop = (
  tempo: Tempo,
  blocks: Float32Array,
): number | undefined => {
  const whole = rangeLoudness(blocks);
  if (whole === undefined) return undefined;
  const window = (WINDOW_BEATS * 60) / tempo.bpm;
  const phrases = new Set(
    marks(tempo, PHRASE).map((time) => time.toFixed(3)),
  );
  let best: { time: number; score: number } | undefined;
  for (const time of marks(tempo, BAR)) {
    const before = rangeLoudness(blocks, time - window, time);
    const after = rangeLoudness(blocks, time, time + window);
    if (before === undefined || after === undefined) continue;
    const lift = after - before;
    if (lift < MIN_LIFT || after < whole - NEAR_FULL) continue;
    const score = lift + (phrases.has(time.toFixed(3)) ? PHRASE_BONUS : 0);
    if (!best || score > best.score) best = { time, score };
  }
  return best?.time;
};

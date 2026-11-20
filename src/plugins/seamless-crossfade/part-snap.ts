/**
 * Moves a song part's edges onto the music's structure: a part starts where
 * a section starts (a phrase start, else a bar start) and ends on one too,
 * instead of a second or two off.
 */
import {
  BAR,
  marksBetween,
  PHRASE,
  type Tempo,
} from '@/plugins/waveform-seekbar/tempo';

import type { Interval } from './play-from';

/** How far (beats) an edge may move to reach a phrase start… */
const PHRASE_REACH = 8;
/** …or, without a clear one, a bar start. */
const BAR_REACH = 2;

/** The phrase (else bar) start closest to `time`, if one is close. */
const snap = (tempo: Tempo, time: number) => {
  const beat = 60 / tempo.bpm;
  const closest = (times: number[]) =>
    times.length
      ? times.reduce((a, b) =>
          Math.abs(b - time) < Math.abs(a - time) ? b : a,
        )
      : undefined;
  const around = (reach: number, every: typeof BAR | typeof PHRASE) =>
    closest(
      marksBetween(tempo, time - (reach * beat), time + (reach * beat), every),
    );
  return around(PHRASE_REACH, PHRASE) ?? around(BAR_REACH, BAR);
};

export const snapPart = (tempo: Tempo, part: Interval): Interval => {
  // A part from the very start stays there.
  const start = part.start >= 1 ? (snap(tempo, part.start) ?? part.start) : 0;
  if (part.end === undefined) return { start };
  const wanted = start + (part.end - part.start);
  const end = snap(tempo, wanted) ?? wanted;
  // Never shorter than half of what was asked.
  return end - start >= (part.end - part.start) / 2
    ? { start, end }
    : { start, end: wanted };
};

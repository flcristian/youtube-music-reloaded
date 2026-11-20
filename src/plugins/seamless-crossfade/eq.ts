/**
 * How the two songs' sound is shaped during a transition: a 3-band EQ
 * (like a DJ mixer's) and a high-pass / low-pass filter, per song.
 */
import type { TransitionStyle } from './settings';

export interface Shape {
  /** Band gains, in dB. */
  low: number;
  mid: number;
  high: number;
  /** Filter cut-offs, in Hz (at their extremes, they let everything by). */
  highPass: number;
  lowPass: number;
}

export const LOW_HZ = 200;
export const MID_HZ = 1000;
export const HIGH_HZ = 3500;
const OPEN_HIGH_PASS = 10;
const OPEN_LOW_PASS = 20_000;

export const FLAT: Shape = {
  low: 0,
  mid: 0,
  high: 0,
  highPass: OPEN_HIGH_PASS,
  lowPass: OPEN_LOW_PASS,
};

/** A band "killed" on a DJ mixer. */
const KILL = -30;
/** When the basslines are swapped (share of the transition). */
const SWAP = 0.5;

/** From `from` to `to` (Hz) on a log scale, as `share` goes 0 to 1. */
const sweep = (from: number, to: number, share: number) =>
  from * ((to / from) ** Math.min(1, Math.max(0, share)));

/** The outgoing song's shape, `progress` (0 to 1) into the transition. */
export const outgoingShape = (
  style: TransitionStyle,
  progress: number,
): Shape => {
  const swapped = progress >= SWAP;
  switch (style) {
    case 'filter':
      // Thins out from the bottom up; its bass goes at the swap.
      return {
        ...FLAT,
        low: swapped ? KILL : 0,
        mid: -6 * progress,
        highPass: sweep(20, 1500, progress ** 1.2),
      };
    case 'bass-swap':
      return {
        ...FLAT,
        low: swapped ? KILL : 0,
        mid: -4 * progress,
        high: -4 * progress,
      };
    default:
      return FLAT;
  }
};

/** The incoming song's shape, `progress` (0 to 1) into the transition. */
export const incomingShape = (
  style: TransitionStyle,
  progress: number,
): Shape => {
  const swapped = progress >= SWAP;
  switch (style) {
    case 'filter':
      // Muffled at first, opening up; its bass comes in at the swap.
      return {
        ...FLAT,
        low: swapped ? 0 : KILL,
        lowPass: sweep(400, OPEN_LOW_PASS, progress ** 0.8),
      };
    case 'bass-swap':
      return {
        ...FLAT,
        low: swapped ? 0 : KILL,
        mid: -4 * (1 - progress),
      };
    default:
      return FLAT;
  }
};

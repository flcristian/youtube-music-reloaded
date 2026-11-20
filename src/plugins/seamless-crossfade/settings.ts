export type FadeCurve = 'equal-power' | 'linear' | 'steep' | 'exponential-out';

export type SeamlessCrossfadeConfig = {
  enabled: boolean;
  /** Crossfade when a song reaches its end. */
  autoEnabled: boolean;
  /** Overlap at the end of a song, in seconds. */
  autoDuration: number;
  /** Crossfade on manual changes (Next/Previous, clicking another song…). */
  manualEnabled: boolean;
  /** How long the song you leave keeps playing, in seconds. */
  manualDuration: number;
  curve: FadeCurve;
  /**
   * "Linear in, exponential out": how hard the outgoing song drops once
   * the incoming one has volume (higher: faster).
   */
  outroSteepness: number;
  /** Crossfade when using "Play from…" (song menu), in seconds. */
  jumpDuration: number;
  /** Clicking play on a song opens "Play from…" to choose a part first. */
  askOnPlay: boolean;
  /** Length of a song's "best part", in seconds. */
  bestPartLength: number;
  /** Songs a "Play/Shuffle best parts" run plays. */
  bestPartsSongs: number;
  /** "Play/Shuffle best parts" plays the whole playlist. */
  bestPartsAll: boolean;
  /** Play every song (or part) at the same loudness. */
  loudnessMatching: boolean;
  /**
   * Automatic and manual crossfades last `fadeBeats` beats of the outgoing
   * song (when its tempo is known) instead of a number of seconds.
   */
  fadeInBeats: boolean;
  fadeBeats: number;
};

export const defaultConfig: SeamlessCrossfadeConfig = {
  enabled: false,
  autoEnabled: true,
  autoDuration: 5,
  manualEnabled: true,
  manualDuration: 5,
  curve: 'equal-power',
  outroSteepness: 5,
  jumpDuration: 5,
  askOnPlay: false,
  bestPartLength: 120,
  bestPartsSongs: 50,
  bestPartsAll: false,
  loudnessMatching: true,
  fadeInBeats: true,
  fadeBeats: 16,
};

export const MIN_PART_LENGTH = 30;
export const MAX_PART_LENGTH = 300;

export const MIN_SONGS = 10;
export const MAX_SONGS = 1000;

export const MIN_BEATS = 4;
export const MAX_BEATS = 64;

export const MIN_STEEPNESS = 1;
export const MAX_STEEPNESS = 10;

export const MIN_DURATION = 0.5;
export const MAX_DURATION = 20;

export const clampDuration = (seconds: number) =>
  Math.min(MAX_DURATION, Math.max(MIN_DURATION, seconds));

export interface Fade {
  /** Volume multipliers for progress `p` in [0, 1]. */
  in: (p: number) => number;
  out: (p: number) => number;
  /**
   * The outgoing song follows the incoming one's progress (it stays up
   * while the incoming one is still silent) instead of its own clock.
   */
  followsIncoming?: boolean;
}

/**
 * Volume multipliers for progress `p` in [0, 1]:
 * `in` for the incoming song, `out` for the outgoing one.
 */
export const curves: Record<Exclude<FadeCurve, 'exponential-out'>, Fade> = {
  // Constant perceived loudness: no dip in the middle.
  'equal-power': {
    in: (p) => Math.sin((p * Math.PI) / 2),
    out: (p) => Math.cos((p * Math.PI) / 2),
  },
  'linear': {
    in: (p) => p,
    out: (p) => 1 - p,
  },
  // New song comes in fast, old one drops away fast.
  'steep': {
    in: (p) => {
      const remaining = (1 - p) ** 3;
      return 1 - remaining;
    },
    out: (p) => (1 - p) ** 3,
  },
};

/** e^(-k·p), scaled to go from 1 down to exactly 0. */
const exponentialOut = (steepness: number) => {
  const floor = Math.exp(-steepness);
  return (p: number) =>
    Math.max(0, (Math.exp(-steepness * p) - floor) / (1 - floor));
};

/** The fade for these settings. */
export const fadeFor = (config: SeamlessCrossfadeConfig): Fade =>
  config.curve === 'exponential-out'
    ? {
        // The new song comes in linearly; the old one drops away fast as
        // soon as the new one has volume.
        in: (p) => p,
        out: exponentialOut(config.outroSteepness),
        followsIncoming: true,
      }
    : curves[config.curve] ?? curves['equal-power'];

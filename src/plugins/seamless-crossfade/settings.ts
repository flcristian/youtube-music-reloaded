export type FadeCurve = 'equal-power' | 'linear' | 'steep';

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
  /** Crossfade when using "Play from…" (song menu), in seconds. */
  jumpDuration: number;
};

export const defaultConfig: SeamlessCrossfadeConfig = {
  enabled: false,
  autoEnabled: true,
  autoDuration: 5,
  manualEnabled: true,
  manualDuration: 5,
  curve: 'equal-power',
  jumpDuration: 5,
};

export const MIN_DURATION = 0.5;
export const MAX_DURATION = 20;

export const clampDuration = (seconds: number) =>
  Math.min(MAX_DURATION, Math.max(MIN_DURATION, seconds));

/**
 * Volume multipliers for progress `p` in [0, 1]:
 * `in` for the incoming song, `out` for the outgoing one.
 */
export const curves: Record<
  FadeCurve,
  { in: (p: number) => number; out: (p: number) => number }
> = {
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

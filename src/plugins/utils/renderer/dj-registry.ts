/**
 * Lets our plugins expose features to each other in the renderer
 * (e.g. the MCP bridge calling "Play from…" or crossfade settings)
 * without going through the UI.
 */
import type { SeamlessCrossfadeConfig } from '@/plugins/seamless-crossfade/settings';

/** Part of a song to play, in song seconds; no `end`: until the end. */
export interface SongInterval {
  start: number;
  end?: number;
}

export type QueuePosition = 'next' | 'end';

export interface DjFeatures {
  /** Play `videoId` now (crossfading), optionally only a part of it. */
  play: (videoId: string, interval: SongInterval) => void;
  /** Add `videoId` to the queue, optionally only a part of it. */
  enqueue: (
    videoId: string,
    interval: SongInterval,
    position: QueuePosition,
  ) => void;
  /** The part of the playing song that plays (start/end in seconds). */
  currentPart: () =>
    | { videoId: string; start: number; end?: number }
    | undefined;
  /**
   * How long before the playing song's end the transition to the next one
   * starts (seconds; undefined if it doesn't happen automatically).
   */
  transitionLead: () => number | undefined;
  /** Move where the playing song ends; `undefined`: until its end. */
  setPartEnd: (end: number | undefined) => void;
  getCrossfadeConfig: () => SeamlessCrossfadeConfig;
  setCrossfadeConfig: (changes: Partial<SeamlessCrossfadeConfig>) => void;
}

let features: DjFeatures | undefined;

export const registerDjFeatures = (value: DjFeatures | undefined) => {
  features = value;
};

export const getDjFeatures = () => features;

/**
 * How loud each part of a song is, from its decoded audio: mean power per
 * short block. Used to level the part that plays against other songs.
 */

/** Block length, in seconds. */
export const BLOCK_SECONDS = 0.4;
/** Blocks quieter than this (dB) are silence and don't count. */
const ABSOLUTE_GATE = -70;
/** Blocks this far (dB) below the average are quiet passages, left out. */
const RELATIVE_GATE = -10;

/** Mean power per `BLOCK_SECONDS`, by video id (null: couldn't measure). */
export const loudnessCache = new Map<string, Float32Array | null>();
const CACHE_SIZE = 30;

export const rememberLoudness = (
  videoId: string,
  blocks: Float32Array | null,
) => {
  loudnessCache.delete(videoId);
  loudnessCache.set(videoId, blocks);
  if (loudnessCache.size > CACHE_SIZE) {
    loudnessCache.delete(loudnessCache.keys().next().value!);
  }
};

export const measureLoudness = (audio: AudioBuffer) => {
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) =>
    audio.getChannelData(i),
  );
  const size = Math.max(1, Math.round(audio.sampleRate * BLOCK_SECONDS));
  const count = Math.floor(audio.length / size);
  const blocks = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    let sum = 0;
    for (let s = b * size; s < (b + 1) * size; s++) {
      let sample = 0;
      for (const channel of channels) sample += channel[s];
      sample /= channels.length;
      sum += sample * sample;
    }
    blocks[b] = sum / size;
  }
  return blocks;
};

const toDb = (power: number) => 10 * Math.log10(power);

/**
 * Loudness (dB, relative scale) between `from` and `to` song seconds (the
 * whole song by default), ignoring silence and quiet passages.
 */
export const rangeLoudness = (
  blocks: Float32Array,
  from = 0,
  to = Infinity,
): number | undefined => {
  const first = Math.max(0, Math.floor(from / BLOCK_SECONDS));
  const last = Math.min(blocks.length, Math.ceil(to / BLOCK_SECONDS));
  const mean = (minimum: number) => {
    let sum = 0;
    let count = 0;
    for (let b = first; b < last; b++) {
      if (blocks[b] > 0 && toDb(blocks[b]) > minimum) {
        sum += blocks[b];
        count++;
      }
    }
    return count ? sum / count : undefined;
  };
  const ungated = mean(ABSOLUTE_GATE);
  if (ungated === undefined) return undefined;
  const gated = mean(Math.max(ABSOLUTE_GATE, toDb(ungated) + RELATIVE_GATE));
  return gated === undefined ? undefined : toDb(gated);
};

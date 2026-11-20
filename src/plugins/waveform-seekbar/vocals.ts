/**
 * Guesses where a song is sung, from its audio (for songs without timed
 * lyrics). Vocals are mostly in the middle of the stereo image, harmonic
 * (clear spectral peaks) and in the voice range; these are measured per
 * frame and compared with the rest of the same song.
 */
import { fft, pause } from './tempo';

import type { Sung } from './lyrics';

/** Frames per second. */
export const VOCAL_FPS = 10;
const FFT_SIZE = 1024;
/** The voice range, in Hz. */
const VOICE_LOW = 250;
const VOICE_HIGH = 3500;
/** A spectral peak: this much above the mean of the bins around it. */
const PEAK_RATIO = 2;
const PEAK_REACH = 8;

/** Per frame: the measurements a guess is made from. */
export interface VocalFeatures {
  /** Middle vs sides energy in the voice range (log ratio). */
  centre: Float32Array;
  /** Share of the voice range's energy in spectral peaks (middle). */
  peaks: Float32Array;
  /** Same, of what's only in the middle (middle minus sides). */
  centrePeaks: Float32Array;
  /** Voice range share of all energy (log). */
  band: Float32Array;
  /** Spectral change in the voice range. */
  flux: Float32Array;
  /** Loudness (log energy). */
  loud: Float32Array;
}

export const vocalCache = new Map<string, VocalFeatures | null>();
const CACHE_SIZE = 30;

export const rememberVocals = (
  videoId: string,
  features: VocalFeatures | null,
) => {
  vocalCache.delete(videoId);
  vocalCache.set(videoId, features);
  while (vocalCache.size > CACHE_SIZE) {
    vocalCache.delete(vocalCache.keys().next().value!);
  }
};

const peakShare = (magnitudes: Float32Array, from: number, to: number) => {
  let all = 0;
  let peaked = 0;
  for (let k = from; k < to; k++) {
    const m = magnitudes[k];
    const energy = m * m;
    all += energy;
    if (m <= magnitudes[k - 1] || m < magnitudes[k + 1]) continue;
    let around = 0;
    let count = 0;
    for (let j = k - PEAK_REACH; j <= k + PEAK_REACH; j++) {
      if (j === k || j < 0 || j >= magnitudes.length) continue;
      around += magnitudes[j];
      count++;
    }
    if (m > (PEAK_RATIO * around) / Math.max(1, count)) peaked += energy;
  }
  return all > 0 ? peaked / all : 0;
};

export const measureVocals = async (
  audio: AudioBuffer,
): Promise<VocalFeatures | null> => {
  if (audio.numberOfChannels < 2) return null;
  const left = audio.getChannelData(0);
  const right = audio.getChannelData(1);
  const rate = audio.sampleRate;
  const hop = Math.round(rate / VOCAL_FPS);
  const frames = Math.max(0, Math.floor((audio.length - FFT_SIZE) / hop));
  const half = FFT_SIZE / 2;
  const low = Math.max(2, Math.round((VOICE_LOW * FFT_SIZE) / rate));
  const high = Math.min(half - 2, Math.round((VOICE_HIGH * FFT_SIZE) / rate));
  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 - (0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
  }
  const mRe = new Float32Array(FFT_SIZE);
  const mIm = new Float32Array(FFT_SIZE);
  const sRe = new Float32Array(FFT_SIZE);
  const sIm = new Float32Array(FFT_SIZE);
  const mid = new Float32Array(half);
  const only = new Float32Array(half);
  const previous = new Float32Array(half);
  const features: VocalFeatures = {
    centre: new Float32Array(frames),
    peaks: new Float32Array(frames),
    centrePeaks: new Float32Array(frames),
    band: new Float32Array(frames),
    flux: new Float32Array(frames),
    loud: new Float32Array(frames),
  };
  for (let f = 0; f < frames; f++) {
    if (f % 200 === 199) await pause();
    const offset = f * hop;
    for (let i = 0; i < FFT_SIZE; i++) {
      const l = left[offset + i];
      const r = right[offset + i];
      mRe[i] = ((l + r) / 2) * window[i];
      sRe[i] = ((l - r) / 2) * window[i];
      mIm[i] = 0;
      sIm[i] = 0;
    }
    fft(mRe, mIm);
    fft(sRe, sIm);
    let all = 0;
    let voice = 0;
    let sides = 0;
    let change = 0;
    for (let k = 1; k < half; k++) {
      const m = Math.hypot(mRe[k], mIm[k]);
      const s = Math.hypot(sRe[k], sIm[k]);
      mid[k] = m;
      only[k] = Math.max(0, m - s);
      all += m * m;
      if (k >= low && k < high) {
        voice += m * m;
        sides += s * s;
        const level = Math.log1p(100 * m);
        change += Math.abs(level - previous[k]);
        previous[k] = level;
      }
    }
    features.centre[f] = Math.log((voice + 1e-9) / (sides + 1e-9));
    features.peaks[f] = peakShare(mid, low, high);
    features.centrePeaks[f] = peakShare(only, low, high);
    features.band[f] = Math.log((voice + 1e-9) / (all + 1e-9));
    features.flux[f] = change / (high - low);
    features.loud[f] = Math.log(all + 1e-9);
  }
  return features;
};

/**
 * Weights per (song-normalised) feature, and the bias: fitted on 29 songs
 * against their timed lyrics. Leans towards "sung" (97% of sung parts are
 * kept; about 40% of intros and breaks are found, 2 in 3 rightly).
 */
export const VOCAL_WEIGHTS: Record<keyof VocalFeatures, number> = {
  centre: 0.215,
  peaks: -1.009,
  centrePeaks: -0.705,
  band: 1.109,
  flux: 0.043,
  loud: 1.416,
};
export const VOCAL_BIAS = 1.2;
/** Smoothing (seconds) and the shortest sung or unsung span kept. */
const SMOOTH = 1.5;
const MIN_SPAN = 2;

/** Each frame's score (above 0: sung). */
export const vocalScores = (
  features: VocalFeatures,
  weights = VOCAL_WEIGHTS,
  bias = VOCAL_BIAS,
) => {
  const frames = features.loud.length;
  const score = new Float32Array(frames).fill(bias);
  // Silence (quieter than the song's own range) is never sung.
  const loudSorted = Float32Array.from(features.loud).sort();
  const floor = loudSorted[Math.floor(frames * 0.05)] ?? 0;
  for (const name of Object.keys(weights) as (keyof VocalFeatures)[]) {
    const weight = weights[name];
    if (!weight) continue;
    const values = features[name];
    let mean = 0;
    for (const v of values) mean += v;
    mean /= Math.max(1, frames);
    let variance = 0;
    for (const v of values) variance += (v - mean) ** 2;
    const sd = Math.sqrt(variance / Math.max(1, frames)) || 1;
    for (let f = 0; f < frames; f++) {
      score[f] += (weight * (values[f] - mean)) / sd;
    }
  }
  // Smooth over a moment (a sung line, not single syllables).
  const reach = Math.round((SMOOTH * VOCAL_FPS) / 2);
  const smooth = new Float32Array(frames);
  let sum = 0;
  for (let f = 0; f < frames + reach; f++) {
    if (f < frames) sum += score[f];
    if (f - (2 * reach) - 1 >= 0) sum -= score[f - (2 * reach) - 1];
    const at = f - reach;
    if (at < 0 || at >= frames) continue;
    const count = Math.min(frames, f + 1) - Math.max(0, f - (2 * reach));
    smooth[at] = features.loud[at] < floor + 1 ? -1 : sum / count;
  }
  return smooth;
};

/** The guessed sung spans of an analysed song (none if not analysed). */
export const guessSung = (videoId: string): Sung[] => {
  const features = vocalCache.get(videoId);
  return features ? sungFromScores(vocalScores(features)) : [];
};

/** Sung spans, in seconds, from per-frame scores. */
export const sungFromScores = (scores: Float32Array): Sung[] => {
  const spans: Sung[] = [];
  let start: number | undefined;
  for (let f = 0; f <= scores.length; f++) {
    const sung = f < scores.length && scores[f] > 0;
    if (sung && start === undefined) start = f;
    if (!sung && start !== undefined) {
      spans.push({ start: start / VOCAL_FPS, end: f / VOCAL_FPS });
      start = undefined;
    }
  }
  // Join spans split by short gaps, then drop short ones.
  const joined: Sung[] = [];
  for (const span of spans) {
    const last = joined.at(-1);
    if (last && span.start - last.end < MIN_SPAN) last.end = span.end;
    else joined.push({ ...span });
  }
  return joined.filter((span) => span.end - span.start >= MIN_SPAN);
};

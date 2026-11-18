/**
 * Tempo and beats of a song, from its decoded audio: an onset curve (how
 * much the sound "hits" at each moment) and the BPM it repeats at. Used to
 * line up the beats of two songs in a crossfade.
 */

/** Onset curve resolution, in values per second. */
export const FPS = 100;
const MIN_BPM = 60;
const MAX_BPM = 200;
/** Tempos far from this are less likely (half/double time ambiguity). */
const LIKELY_BPM = 120;
/** How much a local beat grid must stand out to be trusted. */
const MIN_CONFIDENCE = 1.5;

export interface Tempo {
  bpm: number;
  /** Onset strength, `FPS` values per second of song. */
  envelope: Float32Array;
}

/** Beats around some point of a song, in song seconds. */
export interface BeatGrid {
  /** Seconds per beat. */
  period: number;
  /** The time of one beat (others are whole periods away). */
  beat: number;
}

/** Tempo of recently analysed songs, by video id (null: no clear beat). */
export const tempoCache = new Map<string, Tempo | null>();
const CACHE_SIZE = 30;

export const rememberTempo = (videoId: string, tempo: Tempo | null) => {
  tempoCache.delete(videoId);
  tempoCache.set(videoId, tempo);
  if (tempoCache.size > CACHE_SIZE) {
    tempoCache.delete(tempoCache.keys().next().value!);
  }
};

/**
 * Onset curve: rises in loudness, in the low end (kicks, bass) and in the
 * highs (snares, hats), each on a log scale, minus their local average.
 */
const onsetEnvelope = (audio: AudioBuffer) => {
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) =>
    audio.getChannelData(i),
  );
  const hop = Math.max(1, Math.round(audio.sampleRate / FPS));
  const frames = Math.floor(audio.length / hop);
  const low = new Float32Array(frames);
  const high = new Float32Array(frames);
  // One-pole low-pass at ~150 Hz; the rest (high-passed) is the highs.
  const alpha = 1 - Math.exp((-2 * Math.PI * 150) / audio.sampleRate);
  let smooth = 0;
  let previous = 0;
  for (let f = 0; f < frames; f++) {
    let lowSum = 0;
    let highSum = 0;
    for (let s = f * hop; s < (f + 1) * hop; s++) {
      let sample = 0;
      for (const channel of channels) sample += channel[s];
      sample /= channels.length;
      smooth += alpha * (sample - smooth);
      const diff = sample - previous;
      previous = sample;
      lowSum += smooth * smooth;
      highSum += diff * diff;
    }
    low[f] = Math.log(1e-9 + (lowSum / hop));
    high[f] = Math.log(1e-9 + (highSum / hop));
  }
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    flux[f] =
      Math.max(0, low[f] - low[f - 1]) + Math.max(0, high[f] - high[f - 1]);
  }
  // Keep what stands out from the last half second.
  const span = FPS / 2;
  const envelope = new Float32Array(frames);
  let sum = 0;
  for (let f = 0; f < frames; f++) {
    sum += flux[f];
    if (f >= span) sum -= flux[f - span];
    const mean = sum / Math.min(f + 1, span);
    envelope[f] = Math.max(0, flux[f] - mean);
  }
  return envelope;
};

/** The song's tempo, or `undefined` if it has no clear beat. */
export const analyzeTempo = (audio: AudioBuffer): Tempo | undefined => {
  const envelope = onsetEnvelope(audio);
  const n = envelope.length;
  const minLag = Math.floor((60 * FPS) / MAX_BPM);
  const maxLag = Math.ceil((60 * FPS) / MIN_BPM);
  if (n < maxLag * 8) return undefined;
  const correlation = new Float32Array((maxLag * 2) + 2);
  for (let lag = minLag; lag < correlation.length; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += envelope[i] * envelope[i + lag];
    correlation[lag] = sum / (n - lag);
  }
  let best = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * FPS) / lag;
    const octaves = Math.log2(bpm / LIKELY_BPM);
    // A beat also repeats every two beats.
    const score =
      (correlation[lag] + (0.5 * correlation[lag * 2])) *
      Math.exp(-0.5 * octaves * octaves);
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  if (best < 0 || !(bestScore > 0)) return undefined;
  // Between whole lags (parabola through the neighbours).
  const a = correlation[best - 1];
  const b = correlation[best];
  const c = correlation[best + 1];
  const denominator = a - (2 * b) + c;
  const shift = denominator < 0 ? (0.5 * (a - c)) / denominator : 0;
  const lag = best + Math.max(-0.5, Math.min(0.5, shift));
  return { bpm: (60 * FPS) / lag, envelope };
};

const valueAt = (envelope: Float32Array, at: number) => {
  const i = Math.floor(at);
  if (i < 0 || i + 1 >= envelope.length) return 0;
  const t = at - i;
  return (envelope[i] * (1 - t)) + (envelope[i + 1] * t);
};

/**
 * The beats between `from` and `to` (song seconds): the tempo (within 3%
 * of the song's) and the phase that fit the onsets there best. `undefined`
 * if that stretch has no clear beat.
 */
export const beatGrid = (
  tempo: Tempo,
  from: number,
  to: number,
): BeatGrid | undefined => {
  const { envelope } = tempo;
  const start = Math.max(0, Math.floor(from * FPS));
  const end = Math.min(envelope.length - 1, Math.ceil(to * FPS));
  const base = (60 * FPS) / tempo.bpm;
  if (end - start < base * 6) return undefined;
  let best = { score: -1, period: base, phase: 0, mean: 0 };
  for (let k = -15; k <= 15; k++) {
    const period = base * (1 + (k * 0.002));
    let total = 0;
    let count = 0;
    let top = { score: -1, phase: 0 };
    for (let phase = 0; phase < period; phase += 0.5) {
      let sum = 0;
      let beats = 0;
      for (let at = start + phase; at < end; at += period) {
        sum += valueAt(envelope, at);
        beats++;
      }
      const score = sum / Math.max(1, beats);
      total += score;
      count++;
      if (score > top.score) top = { score, phase };
    }
    if (top.score > best.score) {
      best = { score: top.score, period, phase: top.phase, mean: total / count };
    }
  }
  if (!(best.mean > 0) || best.score / best.mean < MIN_CONFIDENCE) {
    return undefined;
  }
  return { period: best.period / FPS, beat: (start + best.phase) / FPS };
};

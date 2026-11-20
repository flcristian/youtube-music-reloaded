/**
 * Tempo, beats, bars and phrases of a song, from its decoded audio. Used to
 * line up two songs in a crossfade.
 *
 * - Onsets: spectral flux (how much the spectrum "hits" at each moment).
 * - Tempo: autocorrelation of the onsets, scored with its multiples (a beat
 *   also repeats every 2, 3, 4 beats), refined over the whole song.
 * - Beats: followed through the song (dynamic programming), so a drummer
 *   speeding up or slowing down stays on them.
 * - Bars and phrases: where kicks land and where the sound changes (sections
 *   switch at bar and phrase starts). Only trusted when clear.
 */

/** Onset curve resolution, in values per second. */
export const FPS = 100;
const MIN_BPM = 60;
const MAX_BPM = 200;
/** Tempos far from this are less likely (half/double time ambiguity). */
const LIKELY_BPM = 130;
/** Spread of that preference, in octaves. */
const LIKELY_SPREAD = 0.9;
/** How much a local beat grid must stand out to be trusted. */
const MIN_CONFIDENCE = 1.5;
/** How much the likeliest downbeat must beat the next one. */
const MIN_BAR_CONFIDENCE = 1.1;
/** Same, for the likeliest phrase start. */
const MIN_PHRASE_CONFIDENCE = 1.2;
/** Beats per bar and per phrase (8 bars). */
export const BAR = 4;
export const PHRASE = 32;
/** FFT size of the analysis (at the waveform's 8 kHz decode: 64 ms). */
const FFT_SIZE = 512;
/** Band edges for the sound's "colour", in Hz. */
const BAND_EDGES = [0, 150, 600, 2000];
/** Analysis frames between yields to the page. */
const CHUNK = 1500;

export interface Tempo {
  bpm: number;
  /** Onset strength, `FPS` values per second of song. */
  envelope: Float32Array;
  /** Beat times, in song seconds. */
  beats: Float32Array;
  /** Per beat: kick strength, and how much the sound changes there. */
  kick: Float32Array;
  change: Float32Array;
  /** Per beat: same, over two-bar windows (phrase changes). */
  sectionChange: Float32Array;
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

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** In-place radix-2 FFT. */
const fft = (re: Float32Array, im: Float32Array) => {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = (re[b] * cr) - (im[b] * ci);
        const xi = (re[b] * ci) + (im[b] * cr);
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const next = (cr * wr) - (ci * wi);
        ci = (cr * wi) + (ci * wr);
        cr = next;
      }
    }
  }
};

/** What stands out from the last half second (half-wave rectified). */
const detrend = (values: Float32Array) => {
  const span = FPS / 2;
  const out = new Float32Array(values.length);
  let sum = 0;
  let count = 0;
  for (let f = 0; f < values.length; f++) {
    sum += values[f];
    count++;
    if (f >= span) {
      sum -= values[f - span];
      count--;
    }
    out[f] = Math.max(0, values[f] - (sum / count));
  }
  return out;
};

/** Onsets (all, and low end only) and band energies, per frame. */
const analyseFrames = async (audio: AudioBuffer) => {
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) =>
    audio.getChannelData(i),
  );
  const rate = audio.sampleRate;
  const hop = Math.max(1, Math.round(rate / FPS));
  const frames = Math.max(0, Math.floor((audio.length - FFT_SIZE) / hop));
  const half = FFT_SIZE / 2;
  const edges = [
    ...BAND_EDGES.map((hz) => Math.max(1, Math.round((hz * FFT_SIZE) / rate))),
    half,
  ];
  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 - (0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
  }
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  let previous = new Float32Array(half);
  let current = new Float32Array(half);
  const flux = new Float32Array(frames);
  const lowFlux = new Float32Array(frames);
  const bands = BAND_EDGES.map(() => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    if (f % CHUNK === CHUNK - 1) await pause();
    const offset = f * hop;
    for (let i = 0; i < FFT_SIZE; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[offset + i];
      re[i] = (sample / channels.length) * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let rise = 0;
    let lowRise = 0;
    for (let b = 0; b < bands.length; b++) {
      let energy = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) {
        const magnitude = Math.hypot(re[k], im[k]);
        energy += magnitude * magnitude;
        const level = Math.log1p(100 * magnitude);
        current[k] = level;
        const difference = level - previous[k];
        if (difference > 0) {
          rise += difference;
          if (b === 0) lowRise += difference;
        }
      }
      bands[b][f] = Math.log(1e-9 + energy);
    }
    flux[f] = f ? rise : 0;
    lowFlux[f] = f ? lowRise : 0;
    [previous, current] = [current, previous];
  }
  return { envelope: detrend(flux), low: detrend(lowFlux), bands };
};

const interpolate = (values: Float32Array, at: number) => {
  const i = Math.floor(at);
  if (i < 0 || i + 1 >= values.length) return 0;
  const t = at - i;
  return (values[i] * (1 - t)) + (values[i + 1] * t);
};

/** The song's tempo (BPM), or `undefined` if it has no clear beat. */
const estimateBpm = async (envelope: Float32Array) => {
  const n = envelope.length;
  const minLag = (60 * FPS) / MAX_BPM;
  const maxLag = (60 * FPS) / MIN_BPM;
  if (n < maxLag * 8) return undefined;
  const weights = [1, 0.5, 0.33, 0.25];
  const size = Math.min(n - 1, Math.ceil(maxLag * weights.length) + 2);
  const correlation = new Float32Array(size);
  for (let lag = 1; lag < size; lag++) {
    if (lag % 100 === 0) await pause();
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += envelope[i] * envelope[i + lag];
    correlation[lag] = sum / (n - lag);
  }
  let best = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag += 0.05) {
    let score = 0;
    weights.forEach((weight, k) => {
      score += weight * interpolate(correlation, lag * (k + 1));
    });
    const octaves = Math.log2((60 * FPS) / lag / LIKELY_BPM) / LIKELY_SPREAD;
    score *= Math.exp(-0.5 * octaves * octaves);
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  if (best < 0 || !(bestScore > 0)) return undefined;
  await pause();
  return (60 * FPS) / (await refinePeriod(envelope, best));
};

/**
 * The beat period (frames) near `period` that fits the onsets best over the
 * whole song, in 30-second stretches (so a drifting tempo still fits).
 */
const refinePeriod = async (envelope: Float32Array, period: number) => {
  const stretch = 30 * FPS;
  let best = period;
  let bestScore = -1;
  for (let k = -30; k <= 30; k++) {
    if (k % 8 === 0) await pause();
    const candidate = period * (1 + (k * 0.0005));
    let total = 0;
    for (let from = 0; from < envelope.length; from += stretch) {
      const to = Math.min(envelope.length, from + stretch);
      let top = 0;
      for (let phase = 0; phase < candidate; phase += 0.5) {
        let sum = 0;
        let count = 0;
        for (let at = from + phase; at < to; at += candidate) {
          sum += interpolate(envelope, at);
          count++;
        }
        if (count && sum / count > top) top = sum / count;
      }
      total += top;
    }
    if (total > bestScore) {
      bestScore = total;
      best = candidate;
    }
  }
  return best;
};

/** Beat frames, followed through the song (Ellis' dynamic programming). */
const trackBeats = async (envelope: Float32Array, bpm: number) => {
  const n = envelope.length;
  const period = (60 * FPS) / bpm;
  let mean = 0;
  for (const value of envelope) mean += value;
  mean /= n;
  let spread = 0;
  for (const value of envelope) spread += (value - mean) ** 2;
  spread = Math.sqrt(spread / n) || 1;
  const tightness = 100;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const shortest = Math.round(period / 2);
  const longest = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    if (t % (CHUNK * 4) === 0 && t) await pause();
    let best = 0;
    let from = -1;
    for (let tau = Math.max(0, t - longest); tau <= t - shortest; tau++) {
      const stretch = Math.log((t - tau) / period);
      const value = score[tau] - (tightness * stretch * stretch);
      if (from < 0 || value > best) {
        best = value;
        from = tau;
      }
    }
    score[t] = (envelope[t] / spread) + (from >= 0 ? best : 0);
    back[t] = from;
  }
  let end = n - 1;
  let top = -Infinity;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) {
    if (score[t] > top) {
      top = score[t];
      end = t;
    }
  }
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]) {
    beats.push(t);
    if (back[t] < 0) break;
  }
  return beats.reverse();
};

/** Per beat: kick strength and how much the sound changes there. */
const beatFeatures = (
  frames: { low: Float32Array; bands: Float32Array[] },
  beats: number[],
) => {
  const count = beats.length;
  const colour = beats.map((start, i) => {
    const end = i + 1 < count ? beats[i + 1] : start + 1;
    return frames.bands.map((band) => {
      let sum = 0;
      for (let f = start; f < end; f++) sum += band[f];
      return sum / Math.max(1, end - start);
    });
  });
  const kick = Float32Array.from(beats, (f) =>
    Math.max(
      frames.low[f - 1] ?? 0,
      frames.low[f] ?? 0,
      frames.low[f + 1] ?? 0,
    ),
  );
  /** Difference between the `width` beats before and from beat i. */
  const change = (width: number) =>
    Float32Array.from(beats, (_, i) => {
      if (i < width || i + width > count) return 0;
      let total = 0;
      for (let b = 0; b < frames.bands.length; b++) {
        let before = 0;
        let after = 0;
        for (let j = 0; j < width; j++) {
          before += colour[i - 1 - j][b];
          after += colour[i + j][b];
        }
        total += Math.abs(before - after) / width;
      }
      return total;
    });
  return { kick, change: change(BAR), sectionChange: change(BAR * 2) };
};

/** Tempo, beats, bars and phrases; `undefined` if it has no clear beat. */
export const analyzeTempo = async (
  audio: AudioBuffer,
): Promise<Tempo | undefined> => {
  const frames = await analyseFrames(audio);
  const bpm = await estimateBpm(frames.envelope);
  if (!bpm) return undefined;
  await pause();
  const beatFrames = await trackBeats(frames.envelope, bpm);
  await pause();
  const features = beatFeatures(frames, beatFrames);
  return {
    bpm,
    envelope: frames.envelope,
    beats: Float32Array.from(beatFrames, (f) => f / FPS),
    ...features,
  };
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
        sum += interpolate(envelope, at);
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

/** Index of the first beat at or after `time` (song seconds). */
const beatAfter = (beats: Float32Array, time: number) => {
  let low = 0;
  let high = beats.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (beats[middle] < time) low = middle + 1;
    else high = middle;
  }
  return low;
};

const confidence = (scores: number[]) => {
  const sorted = [...scores].sort((a, b) => b - a);
  return sorted[0] / (sorted[1] || Number.EPSILON);
};

/**
 * Which beats start bars and phrases around beat `index` (as offsets: beat
 * i starts a bar when i % 4 === bar). Each is `undefined` when unclear.
 */
const marksAround = (tempo: Tempo, index: number) => {
  const span = PHRASE * 2;
  const from = Math.max(0, index - span);
  const to = Math.min(tempo.beats.length, index + span);
  const mean = (values: Float32Array) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += values[i];
    return sum / Math.max(1, to - from) || 1;
  };
  const kick = mean(tempo.kick);
  const change = mean(tempo.change);
  const section = mean(tempo.sectionChange);
  const bars = new Array<number>(BAR).fill(0);
  for (let i = from; i < to; i++) {
    bars[i % BAR] += (tempo.kick[i] / kick) + (tempo.change[i] / change);
  }
  if (confidence(bars) < MIN_BAR_CONFIDENCE) return {};
  const bar = bars.indexOf(Math.max(...bars));
  const phrases = new Array<number>(PHRASE / BAR).fill(0);
  for (let i = from; i < to; i++) {
    if (i % BAR !== bar) continue;
    phrases[Math.floor(mod(i - bar, PHRASE) / BAR)] +=
      tempo.sectionChange[i] / section;
  }
  const phrase =
    confidence(phrases) >= MIN_PHRASE_CONFIDENCE
      ? bar + (phrases.indexOf(Math.max(...phrases)) * BAR)
      : undefined;
  return { bar, phrase };
};

const mod = (a: number, b: number) => ((a % b) + b) % b;

/**
 * Song times (seconds) between `from` and `to` that start a beat
 * (`every` 1), a bar (4) or a phrase (32). Empty when that is unclear there.
 */
export const marksBetween = (
  tempo: Tempo,
  from: number,
  to: number,
  every: 1 | typeof BAR | typeof PHRASE,
) => {
  const { beats } = tempo;
  const first = beatAfter(beats, from);
  const last = beatAfter(beats, to);
  if (first >= beats.length) return [];
  let offset = 0;
  if (every !== 1) {
    const marks = marksAround(tempo, Math.min(beats.length - 1, first));
    const found = every === BAR ? marks.bar : marks.phrase;
    if (found === undefined) return [];
    offset = found;
  }
  const times: number[] = [];
  for (let i = first; i < last; i++) {
    if (mod(i - offset, every) === 0) times.push(beats[i]);
  }
  return times;
};

/** Seconds from `time` to the next bar start, if clear there. */
export const toNextBar = (tempo: Tempo, time: number) => {
  const period = 60 / tempo.bpm;
  const [next] = marksBetween(tempo, time, time + (period * BAR * 1.5), BAR);
  return next === undefined ? undefined : next - time;
};

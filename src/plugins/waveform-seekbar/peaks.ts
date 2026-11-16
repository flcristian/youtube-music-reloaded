/** Number of bars computed per song (resampled to the canvas width). */
export const PEAK_COUNT = 1000;
/** Decoding at a low rate keeps memory small; peaks don't need more. */
const DECODE_RATE = 8000;

export interface AudioSource {
  url: string;
  /** Song duration in seconds, from the `dur` URL parameter. */
  duration: number;
  /** Full file size in bytes, from the `clen` URL parameter. */
  size: number;
}

/**
 * Remembers the audio stream URLs the player requests. Each URL carries the
 * song's duration and file size, enough to download the whole file once.
 */
export class AudioSources {
  private readonly sources: AudioSource[] = [];
  private observer?: PerformanceObserver;

  start() {
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) this.add(entry.name);
    });
    // `buffered` also delivers requests made before the plugin started.
    this.observer.observe({ type: 'resource', buffered: true });
  }

  stop() {
    this.observer?.disconnect();
  }

  private add(name: string) {
    if (!name.includes('videoplayback') || !name.includes('mime=audio')) {
      return;
    }
    const source = AudioSources.fromUrl(name);
    if (!source) return;
    this.sources.push(source);
    if (this.sources.length > 50) this.sources.shift();
  }

  /** Build a source from a stream URL (it carries `dur` and `clen`). */
  static fromUrl(name: string): AudioSource | undefined {
    const url = new URL(name);
    const duration = Number(url.searchParams.get('dur'));
    const size = Number(url.searchParams.get('clen'));
    if (!(duration > 0 && size > 0)) return undefined;
    return { url: name, duration, size };
  }

  /** The most recent stream whose duration matches the song's. */
  find(songLength: number): AudioSource | undefined {
    for (let i = this.sources.length - 1; i >= 0; i--) {
      const source = this.sources[i];
      if (Math.abs(source.duration - songLength) <= 1) return source;
    }
    return undefined;
  }
}

/**
 * Waveforms of recently played songs, by video id. Shared, so other
 * features (e.g. "Play from…") can show a song's waveform.
 */
export const peaksCache = new Map<string, Float32Array>();
const CACHE_SIZE = 30;

export const rememberPeaks = (videoId: string, peaks: Float32Array) => {
  peaksCache.delete(videoId);
  peaksCache.set(videoId, peaks);
  if (peaksCache.size > CACHE_SIZE) {
    peaksCache.delete(peaksCache.keys().next().value!);
  }
};

/** Download the whole audio file in a single request. */
const download = async (source: AudioSource) => {
  const url = new URL(source.url);
  url.searchParams.set('range', `0-${source.size - 1}`);
  // Plain media response instead of the player's framed (UMP) format.
  url.searchParams.delete('ump');
  url.searchParams.delete('rn');
  const response = await fetch(url, {
    method: 'POST',
    body: 'x\u0000',
    credentials: 'include',
  });
  if (!response.ok) throw new Error(`audio download: ${response.status}`);
  return response.arrayBuffer();
};

/** Height of the quietest bars, so they stay visible. */
const MIN_LEVEL = 0.12;

/**
 * Loudness (0–1) along the whole song, `PEAK_COUNT` values.
 *
 * Uses RMS (average energy) instead of sample peaks: mastered music peaks
 * near full scale almost everywhere, so peaks look flat. The values are
 * then mapped on a dB scale relative to the song's own loudness range, so
 * quiet and loud sections of the same song are clearly different.
 */
export const computePeaks = async (source: AudioSource) => {
  const data = await download(source);
  const context = new OfflineAudioContext(1, 1, DECODE_RATE);
  const audio = await context.decodeAudioData(data);

  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) =>
    audio.getChannelData(i),
  );
  const levels = new Float32Array(PEAK_COUNT);
  const perPeak = audio.length / PEAK_COUNT;
  for (let i = 0; i < PEAK_COUNT; i++) {
    const from = Math.floor(i * perPeak);
    const to = Math.min(audio.length, Math.floor((i + 1) * perPeak));
    let sum = 0;
    for (const channel of channels) {
      for (let s = from; s < to; s++) sum += channel[s] * channel[s];
    }
    const count = Math.max(1, (to - from) * channels.length);
    const meanSquare = sum / count;
    const db = 10 * Math.log10(meanSquare + 1e-12);
    levels[i] = db;
  }
  // Stretch this song's own loudness range (ignoring the quietest 10% and
  // the loudest 1%) over the full height, so differences stay visible
  // even in songs that are loud all the way through.
  const sorted = Float32Array.from(levels).sort();
  const low = sorted[Math.floor(PEAK_COUNT * 0.1)];
  const high = sorted[Math.floor(PEAK_COUNT * 0.99)];
  const span = Math.max(1, high - low);
  for (let i = 0; i < PEAK_COUNT; i++) {
    const relative = Math.min(1, Math.max(0, (levels[i] - low) / span));
    const scaled = (1 - MIN_LEVEL) * relative;
    levels[i] = MIN_LEVEL + scaled;
  }
  return levels;
};

/** Finds the stream URL of any song (via the main process). */
let resolveUrl: ((videoId: string) => Promise<string | null>) | undefined;
const pending = new Map<string, Promise<Float32Array | undefined>>();

export const setUrlResolver = (
  resolver: ((videoId: string) => Promise<string | null>) | undefined,
) => {
  resolveUrl = resolver;
};

/**
 * The waveform of any song: from the cache, or by having a hidden muted
 * player load it. `undefined` when it can't be found.
 */
export const loadPeaks = (videoId: string) => {
  const cached = peaksCache.get(videoId);
  if (cached) return Promise.resolve(cached);
  const running = pending.get(videoId);
  if (running) return running;
  if (!resolveUrl) return Promise.resolve(undefined);

  const job = resolveUrl(videoId)
    .then(async (url) => {
      const source = url ? AudioSources.fromUrl(url) : undefined;
      if (!source) return undefined;
      const peaks = await computePeaks(source);
      rememberPeaks(videoId, peaks);
      return peaks;
    })
    .catch((err) => {
      console.warn('[waveform-seekbar]', err);
      return undefined;
    })
    .finally(() => pending.delete(videoId));
  pending.set(videoId, job);
  return job;
};

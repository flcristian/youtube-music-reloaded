/**
 * Loudness matching: plays every song at the same loudness, including the
 * quiet ones YouTube Music leaves quiet (it only turns loud songs down, via
 * the <video>'s volume).
 *
 * Each media element (the player's <video>, and each outgoing song's
 * <audio>) goes through its own gain into a shared safety limiter, so
 * boosted songs never clip. The elements' `volume` still applies before
 * the gain, so fades work as before.
 *
 * Everything runs in the app's own audio context (the one the <video> is
 * already routed through at start-up): elements on another context, or
 * playing directly, reach the speakers with a different delay, and
 * handing a song from one element to another would stutter. So outgoing
 * songs always go through it, even with loudness matching off.
 *
 * Loudness: YouTube's own number for the whole song, corrected by how much
 * louder or quieter the part that plays is than the whole song (measured
 * on the waveform's decode).
 */
import {
  loudnessCache,
  rangeLoudness,
} from '@/plugins/waveform-seekbar/loudness';

import { FLAT, HIGH_HZ, LOW_HZ, MID_HZ, type Shape } from './eq';
import { LOOP_PROCESSOR, loadLoopWorklet } from './loop-worklet';

import type { MusicPlayer } from '@/types/music-player';

/** Most a quiet song is boosted, in dB. */
const MAX_BOOST = 10;
/** Most a loud song is turned down on top of YouTube, in dB. */
const MAX_CUT = 12;
/** Changes smaller than this (dB) are left alone. */
const MIN_CHANGE = 0.25;
/** Longest echo delay, in seconds. */
const MAX_ECHO = 2;
/** How long a done-with element's echoes may ring on, in milliseconds. */
const RING_OUT = 10_000;
/** Limiter: peaks above this (dBFS) are held down. */
const LIMIT_THRESHOLD = -1;
const LIMIT_RATIO = 20;

const fromDb = (db: number) => 10 ** (db / 20);

interface AudioConfig {
  loudnessDb?: number;
  trackAbsoluteLoudnessLkfs?: number;
  loudnessTargetLkfs?: number;
}

export class Leveler {
  private context?: AudioContext;
  private input?: AudioNode;
  private readonly gains = new WeakMap<HTMLMediaElement, GainNode>();
  /** Each element's EQ and filters (transition styles). */
  private readonly shapers = new WeakMap<
    HTMLMediaElement,
    {
      source: MediaElementAudioSourceNode;
      low: BiquadFilterNode;
      mid: BiquadFilterNode;
      high: BiquadFilterNode;
      highPass: BiquadFilterNode;
      lowPass: BiquadFilterNode;
      loop?: AudioWorkletNode;
      level: GainNode;
      echo: GainNode;
      delay: DelayNode;
      echoFilter: BiquadFilterNode;
      feedback: GainNode;
      all: AudioNode[];
    }
  >();
  /** Whether the loop worklet is loaded. */
  private loopReady = false;
  private video?: HTMLVideoElement;
  /** Song and gain (dB) last applied to the player. */
  private applied?: { videoId: string; db: number };
  /** The app's source for its original <video>. */
  private sharedSource?: MediaElementAudioSourceNode;
  /** The newest outgoing-song element, not routed yet (no graph yet). */
  private pendingMirror?: HTMLMediaElement;

  constructor(
    private readonly api: MusicPlayer,
    private readonly enabled: () => boolean,
    /** The part of the playing song that plays, if one was chosen. */
    private readonly currentPart: () =>
      | { videoId: string; start: number; end?: number }
      | undefined,
  ) {
    document.addEventListener('peard:audio-can-play', this.onAudioReady);
  }

  /** The app shares its audio context and the <video>'s source. */
  private readonly onAudioReady = (event: Event) => {
    const { detail } = event as CustomEvent<
      | {
          audioContext?: AudioContext;
          audioSource?: MediaElementAudioSourceNode;
        }
      | undefined
    >;
    const context = detail?.audioContext;
    if (!context || (this.context && this.context !== context)) return;
    this.sharedSource ??= detail.audioSource;
    if (!this.context) this.buildGraph(context);
    this.update();
  };

  /** Follow this <video> (the player's, or its replacement). */
  setVideo(video: HTMLVideoElement) {
    if (video === this.video) return;
    this.video?.removeEventListener('timeupdate', this.update);
    this.video = video;
    video.addEventListener('timeupdate', this.update);
    this.applied = undefined;
    this.update();
  }

  /**
   * A new outgoing-song element: route it now, while it's silent. Routing
   * an element that is already playing drops a moment of its sound.
   */
  prepare(audio: HTMLMediaElement) {
    if (this.context) this.route(audio);
    else this.pendingMirror = audio;
  }

  /**
   * The playing song becomes an outgoing one on `audio`: it keeps the
   * player's gain, and the player's is free for the next song.
   */
  handOff(audio: HTMLMediaElement) {
    const video = this.video;
    const from = video && this.gains.get(video);
    if (!from || !this.context) return;
    const gain = this.route(audio);
    gain?.gain.setValueAtTime(from.gain.value, this.context.currentTime);
    this.applied = undefined;
  }

  /** Shape this element's sound (EQ and filters) for a transition. */
  shape(element: HTMLMediaElement, shape: Shape) {
    if (!this.context) return;
    this.route(element);
    const nodes = this.shapers.get(element);
    if (!nodes) return;
    const now = this.context.currentTime;
    // Quick, but without clicks.
    const set = (param: AudioParam, value: number) => {
      if (Math.abs(param.value - value) > 1e-3) {
        param.setTargetAtTime(value, now, 0.02);
      }
    };
    set(nodes.low.gain, shape.low);
    set(nodes.mid.gain, shape.mid);
    set(nodes.high.gain, shape.high);
    set(nodes.highPass.frequency, shape.highPass);
    set(nodes.echoFilter.frequency, Math.max(shape.highPass, 120));
    set(nodes.lowPass.frequency, shape.lowPass);
    set(nodes.level.gain, shape.level);
    set(nodes.echo.gain, shape.echo);
    set(nodes.feedback.gain, Math.min(0.9, shape.feedback));
    if (Math.abs(nodes.delay.delayTime.value - shape.echoTime) > 1e-3) {
      nodes.delay.delayTime.setValueAtTime(
        Math.min(MAX_ECHO, shape.echoTime),
        now,
      );
    }
  }

  /**
   * Loop out: after `after` seconds, repeat the last `length` seconds of
   * this element's sound (sample-accurately). False if it can't.
   */
  loop(element: HTMLMediaElement, after: number, length: number) {
    if (!this.context) return false;
    this.route(element);
    const node = this.shapers.get(element)?.loop;
    if (!node) return false;
    node.port.postMessage({ loop: true, after, length });
    return true;
  }

  /** Pause or resume this element's loop (with the player). */
  hold(element: HTMLMediaElement, held: boolean) {
    this.shapers.get(element)?.loop?.port.postMessage({ held });
  }

  /**
   * Done with this element: silence it now, let its echoes ring out, then
   * take its nodes out of the graph.
   */
  release(element: HTMLMediaElement) {
    const nodes = this.shapers.get(element);
    if (!nodes || !this.context || element === this.video) return;
    nodes.loop?.port.postMessage({ stop: true });
    nodes.level.gain.setTargetAtTime(0, this.context.currentTime, 0.02);
    nodes.echo.gain.setTargetAtTime(0, this.context.currentTime, 0.02);
    this.shapers.delete(element);
    const gain = this.gains.get(element);
    this.gains.delete(element);
    setTimeout(() => {
      for (const node of [...nodes.all, gain]) {
        try {
          node?.disconnect();
        } catch {}
      }
    }, RING_OUT);
  }

  stop() {
    document.removeEventListener('peard:audio-can-play', this.onAudioReady);
    this.video?.removeEventListener('timeupdate', this.update);
    this.video = undefined;
    // Elements can't be taken out of the graph: just stop changing them.
    const now = this.context?.currentTime ?? 0;
    for (const element of document.querySelectorAll('video')) {
      this.gains.get(element)?.gain.setValueAtTime(1, now);
      this.shape(element, FLAT);
    }
  }

  /** Apply the playing song's gain (on every `timeupdate`). */
  private readonly update = () => {
    const video = this.video;
    if (!video) return;
    // Into the graph as soon as possible (ideally before it plays): every
    // element must take the same path to the speakers, or their delays
    // differ and handing a song from one element to another stutters.
    if (!this.context) return;
    this.route(video);
    const videoId = this.api.getVideoData()?.video_id;
    if (!videoId) return;
    const db = this.enabled() ? this.gainFor(videoId) : 0;
    if (db === undefined) return;
    const applied = this.applied;
    if (
      applied?.videoId === videoId &&
      Math.abs(applied.db - db) < MIN_CHANGE
    ) {
      return;
    }
    const { context } = this;
    const gain = context && this.route(video);
    if (!context || !gain) return;
    // A new song: right away (it starts silent while crossfading).
    // Same song (its part was measured later): slowly.
    const smoothing = applied?.videoId === videoId ? 1 : 0.02;
    gain.gain.setTargetAtTime(fromDb(db), context.currentTime, smoothing);
    this.applied = { videoId, db };
  };

  /** Extra gain (dB) for the playing song, on top of YouTube's own. */
  private gainFor(videoId: string) {
    const response = this.api.getPlayerResponse();
    if (response?.videoDetails?.videoId !== videoId) return undefined;
    const config = response.playerConfig?.audioConfig as
      | AudioConfig
      | undefined;
    const loudness = config?.trackAbsoluteLoudnessLkfs;
    const target = config?.loudnessTargetLkfs;
    if (loudness === undefined || target === undefined) return 0;
    // What YouTube already does: turns loud songs down, never up.
    const youtube = -Math.max(0, config?.loudnessDb ?? loudness - target);

    // The part that plays vs. the whole song.
    let partDifference = 0;
    const part = this.currentPart();
    const blocks = loudnessCache.get(videoId);
    if (part && part.videoId === videoId && blocks) {
      const whole = rangeLoudness(blocks);
      const chosen = rangeLoudness(blocks, part.start, part.end);
      if (whole !== undefined && chosen !== undefined) {
        partDifference = chosen - whole;
      }
    }
    const wanted = target - (loudness + partDifference);
    return Math.min(MAX_BOOST, Math.max(-MAX_CUT, wanted - youtube));
  }

  /** Limiter (and its makeup correction) in front of the speakers. */
  private buildGraph(context: AudioContext) {
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = LIMIT_THRESHOLD;
    limiter.knee.value = 0;
    limiter.ratio.value = LIMIT_RATIO;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    // The compressor adds "makeup" gain; take it back out.
    const fullRange = LIMIT_THRESHOLD - (LIMIT_THRESHOLD / LIMIT_RATIO);
    const makeup = context.createGain();
    makeup.gain.value = fromDb(0.6 * fullRange);
    limiter.connect(makeup);
    makeup.connect(context.destination);
    this.input = limiter;
    this.context = context;
    loadLoopWorklet(context)
      .then(() => {
        this.loopReady = true;
      })
      .catch((err) => console.warn('[seamless-crossfade] loop out', err));
    const pending = this.pendingMirror;
    this.pendingMirror = undefined;
    if (pending) this.route(pending);
  }

  /** The element's gain in the graph (routes it there the first time). */
  private route(element: HTMLMediaElement) {
    const existing = this.gains.get(element);
    if (existing) return existing;
    const { context, input } = this;
    if (!context || !input) return undefined;
    let source: MediaElementAudioSourceNode;
    if (this.sharedSource?.mediaElement === element) {
      // The app's own: take it off its direct line to the speakers.
      source = this.sharedSource;
      try {
        source.disconnect(context.destination);
      } catch {}
    } else {
      source = context.createMediaElementSource(element);
    }
    const filter = (type: BiquadFilterType, frequency: number) => {
      const node = context.createBiquadFilter();
      node.type = type;
      node.frequency.value = frequency;
      return node;
    };
    const nodes = {
      low: filter('lowshelf', LOW_HZ),
      mid: filter('peaking', MID_HZ),
      high: filter('highshelf', HIGH_HZ),
      highPass: filter('highpass', FLAT.highPass),
      lowPass: filter('lowpass', FLAT.lowPass),
    };
    nodes.mid.Q.value = 0.7;
    nodes.highPass.Q.value = Math.SQRT1_2;
    nodes.lowPass.Q.value = Math.SQRT1_2;
    const gain = context.createGain();
    // Loop out (only outgoing songs, i.e. not the player's own element).
    const loop =
      this.loopReady && element !== this.sharedSource?.mediaElement
        ? new AudioWorkletNode(context, LOOP_PROCESSOR, {
            outputChannelCount: [2],
          })
        : undefined;
    const level = context.createGain();
    // Echo out: a delay feeding back into itself through a high-pass.
    const echo = context.createGain();
    echo.gain.value = 0;
    const delay = context.createDelay(MAX_ECHO);
    delay.delayTime.value = FLAT.echoTime;
    const echoFilter = filter('highpass', 120);
    const feedback = context.createGain();
    feedback.gain.value = 0;
    let shaped: AudioNode = source
      .connect(nodes.low)
      .connect(nodes.mid)
      .connect(nodes.high)
      .connect(nodes.highPass)
      .connect(nodes.lowPass);
    if (loop) shaped = shaped.connect(loop);
    shaped.connect(level).connect(gain);
    shaped.connect(echo).connect(delay).connect(echoFilter);
    echoFilter.connect(feedback).connect(delay);
    echoFilter.connect(gain);
    gain.connect(input);
    this.gains.set(element, gain);
    this.shapers.set(element, {
      ...nodes,
      source,
      loop,
      level,
      echo,
      delay,
      echoFilter,
      feedback,
      all: [
        source,
        ...Object.values(nodes),
        ...(loop ? [loop] : []),
        level,
        echo,
        delay,
        echoFilter,
        feedback,
      ],
    });
    return gain;
  }
}

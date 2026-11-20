import { loadTempo } from '@/plugins/waveform-seekbar/peaks';
import {
  BAR,
  beatGrid,
  marksBetween,
  PHRASE,
  tempoCache,
  toNextBar,
  type BeatGrid,
  type Tempo,
} from '@/plugins/waveform-seekbar/tempo';

import {
  clampDuration,
  fadeFor,
  type Fade,
  type SeamlessCrossfadeConfig,
} from './settings';

import type { MirrorManager, StreamMirror } from './mirror';
import type { GetState } from '@/types/datahost-get-state';
import type { MusicPlayer } from '@/types/music-player';

/** Restore the volume if the next song hasn't started within this time. */
const NEXT_SONG_TIMEOUT = 6000;
/** A teardown this soon after our own end-of-song skip counts as automatic. */
const AUTO_SKIP_WINDOW = 1500;
/** How long a requested "Play from…" may take to reach the player. */
const JUMP_WINDOW = 5000;
const TICK_MS = 30;
/**
 * Automatic crossfade: the outgoing song's mirror starts this many seconds
 * before the skip, muted and kept in step with the player, so at the skip
 * it only has to be unmuted (starting it then lags behind: the page is
 * busy for a moment while the player changes songs).
 */
const PREROLL_LEAD = 1;
/** Give up getting in step after this long and skip anyway, in ms. */
const PREROLL_TIMEOUT = 1500;
/** In step when this close, in seconds. */
const PREROLL_TOLERANCE = 0.01;

/**
 * Beat matching: the outgoing song's tempo is bent (pitch kept) by at most
 * this share to follow the incoming one's; further apart, only the first
 * beats are lined up.
 */
const MAX_BEND = 0.08;
/** Extra bend used to pull drifting beats back together. */
const MAX_NUDGE = 0.03;
/** Bend per second of beat offset (how hard drift is corrected). */
const NUDGE_GAIN = 0.5;
/** Offsets below this (seconds) are left alone. */
const BEAT_TOLERANCE = 0.008;
/** How fast the outgoing song's speed may change, per second. */
const BEND_SLEW = 0.05;
/**
 * Speed changes are applied at most this often (ms) and in steps of at
 * least this size: each one costs the time-stretcher a small glitch.
 */
const BEND_INTERVAL = 500;
const BEND_STEP = 0.005;
/** Seeks the incoming song may take to land on the beat. */
const ALIGN_ATTEMPTS = 3;
/**
 * An automatic crossfade starts on a phrase (or bar) start of the outgoing
 * song: up to this many beats before the planned moment…
 */
const ALIGN_EARLY_BEATS = 16;
/** …or this many after (its tail is then a little shorter). */
const ALIGN_LATE_BEATS = 2;
/** Most seconds an automatic crossfade can be moved earlier. */
const ALIGN_EARLY_MAX = 12;

/** Positive remainder. */
const mod = (value: number, by: number) => ((value % by) + by) % by;
/** `value` folded into -by/2 … by/2. */
const wrap = (value: number, by: number) =>
  mod(value + (by / 2), by) - (by / 2);
const clamp = (value: number, limit: number) =>
  Math.min(limit, Math.max(-limit, value));

/** Seconds until the next beat of `grid`, at song time `time`. */
const toNextBeat = (grid: BeatGrid, time: number) =>
  mod(grid.beat - time, grid.period);

/** The playing song's next song in the queue, if any. */
const nextInQueue = () => {
  type Renderer = { videoId?: string; selected?: boolean };
  type Item = {
    playlistPanelVideoRenderer?: Renderer;
    playlistPanelVideoWrapperRenderer?: {
      primaryRenderer?: { playlistPanelVideoRenderer?: Renderer };
    };
  };
  const queue = document.querySelector<
    HTMLElement & {
      queue?: {
        store?: { store?: { getState(): { queue?: { items?: Item[] } } } };
      };
    }
  >('#queue');
  const items = queue?.queue?.store?.store?.getState().queue?.items ?? [];
  const song = (item: Item | undefined) =>
    item?.playlistPanelVideoRenderer ??
    item?.playlistPanelVideoWrapperRenderer?.primaryRenderer
      ?.playlistPanelVideoRenderer;
  const current = items.findIndex((item) => song(item)?.selected);
  return current < 0 ? undefined : song(items[current + 1])?.videoId;
};

/**
 * Lining up the beats of the song fading out (`audio`) with the one fading
 * in (the player).
 */
interface BeatSync {
  audio: HTMLAudioElement;
  /** The outgoing song's tempo, and its media time minus song time. */
  tempo: Tempo;
  shift: number;
  /** Its normal playback rate. */
  baseRate: number;
  /** Seeks made on the incoming song, and how far they moved it. */
  attempts: number;
  /** When its speed was last changed (performance.now()). */
  bentAt: number;
  skipped: number;
  /** Once the incoming song plays: both beat grids, and the bend. */
  lock?: {
    out: BeatGrid;
    in: BeatGrid;
    ratio: number;
    bend: boolean;
    incoming: Tempo;
  };
  /** The incoming song's bars were looked at, and lined up. */
  barsDone?: boolean;
  barsAligned?: boolean;
}

const volumeDesc = Object.getOwnPropertyDescriptor(
  HTMLMediaElement.prototype,
  'volume',
)!;
/** Set the element's real volume, bypassing our own override. */
const setVolume = (media: HTMLMediaElement, value: number) =>
  volumeDesc.set!.call(media, Math.min(1, Math.max(0, value)));

/**
 * Calls `frame(now)` every ~30 ms until it returns false; returns a cancel
 * function. Uses a timer, not requestAnimationFrame: rAF stops completely
 * while the window is minimised or covered, which is most of the time for
 * a music player. Fades are computed from the clock, so they still end on
 * time even if timers get throttled.
 */
const loop = (frame: (now: number) => boolean) => {
  const id = setInterval(() => {
    if (!frame(performance.now())) clearInterval(id);
  }, TICK_MS);
  return () => clearInterval(id);
};

const getRepeatMode = () => {
  try {
    return document
      .querySelector<HTMLElement & { getState: () => GetState }>(
        'ytmusic-player-bar',
      )
      ?.getState().queue.repeatMode;
  } catch {
    return undefined;
  }
};

interface Tail {
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

/**
 * Crossfades on every song change while music is playing:
 * - manual (Next/Previous, clicking another song, …): the song you left
 *   keeps playing for `manualDuration` seconds from where it was, fading out;
 * - automatic: `autoDuration` seconds before a song ends we skip to the next
 *   one ourselves, so the ending overlaps the next song's start.
 *
 * The outgoing audio comes from a live mirror of the player's stream
 * (see mirror.ts); the incoming song is faded in on the player itself.
 *
 * A crossfade lives as long as playback does: pausing freezes both songs
 * and both fade clocks, resuming continues exactly where it was. Only an
 * actual song change while paused cancels it. The outgoing song follows
 * the player's volume and mute.
 */
export class Crossfader {
  private readonly tails = new Set<Tail>();
  /** The user's volume while a fade-in is running (the player's view). */
  private target?: number;
  private fadeIn?: {
    /** ms spent waiting for the next song to start (not counting pauses). */
    waited: number;
    /** ms of fade-in actually played (not counting pauses). */
    elapsed?: number;
    duration: number;
    curve: Fade;
  };
  private cancelFadeIn?: () => void;
  /** Paused by the user (as opposed to the player loading a new song). */
  private userPaused = false;
  private autoSkippedFor?: string;
  /** Where the playing song's automatic crossfade starts (media time). */
  private skipPlan?: { key: string; at: number };
  private autoSkipAt = -Infinity;
  /** A "Play from…" in progress: crossfade with its own duration. */
  private jump?: { at: number; duration: number; startAt: number };
  private reloadChecked = false;
  /** The song playing, and its media time minus song time. */
  private playing?: { videoId: string; shift: number };
  private beatSync?: BeatSync;
  /** Song whose next song's tempo was last requested, and that song. */
  private prefetched?: string;
  /** How far the incoming song's fade-in is (0–1), once it has started. */
  private incomingProgress?: number;
  /** The outgoing mirror, playing muted ahead of an automatic skip. */
  private preroll?: { audio: HTMLAudioElement; cancel: () => void };

  constructor(
    private readonly api: MusicPlayer,
    private video: HTMLVideoElement,
    private readonly mirrors: MirrorManager,
    private readonly getSettings: () => SeamlessCrossfadeConfig,
  ) {}

  attach() {
    const { video } = this;
    video.addEventListener('timeupdate', this.onTimeUpdate);
    video.addEventListener('pause', this.onPause);
    video.addEventListener('play', this.onPlay);
    video.addEventListener('playing', this.ensureMirrored);
    this.hookTeardown();
    this.userPaused = video.paused;
    if (!video.paused) this.ensureMirrored();
  }

  /** Move onto a new <video> element (YouTube Music replaced it). */
  setVideo(video: HTMLVideoElement) {
    if (video === this.video) return;
    this.detach();
    this.video = video;
    this.attach();
  }

  detach() {
    const { video } = this;
    video.removeEventListener('timeupdate', this.onTimeUpdate);
    video.removeEventListener('pause', this.onPause);
    video.removeEventListener('play', this.onPlay);
    video.removeEventListener('playing', this.ensureMirrored);
    // Remove the instance-level overrides, falling back to the prototype.
    Reflect.deleteProperty(video, 'removeAttribute');
    Reflect.deleteProperty(video, 'src');
    this.cancelAll();
  }

  /**
   * The next song change is a "Play from…": crossfade into it over
   * `duration` seconds (regardless of the manual crossfade setting),
   * keeping it silent until it has reached `startAt` seconds.
   */
  prepareJump(duration: number, startAt: number) {
    this.jump = { at: performance.now(), duration, startAt };
  }

  /** Where a queued song will start (it's held silent until then). */
  scheduledStart?: (videoId: string | undefined) => number | undefined;
  /** Where the playing song's chosen part starts, once it plays. */
  partStart?: (videoId: string | undefined) => number | undefined;
  /** The playing song moves to `audio` (loudness matching follows it). */
  handOff?: (audio: HTMLMediaElement) => void;
  /** A chosen end for the playing song (song seconds), if any. */
  intervalEnd?: (videoId: string | undefined) => number | undefined;

  /** End of the playing song on the media timeline, honouring `intervalEnd`. */
  private songEnd(mirrorEnd: number, time: number) {
    const chosen = this.intervalEnd?.(this.api.getVideoData()?.video_id);
    if (chosen === undefined) return mirrorEnd;
    const songStart = time - this.api.getCurrentTime();
    return Math.min(mirrorEnd, songStart + chosen);
  }

  /** Stop every outgoing song and settle the incoming one at full volume. */
  private cancelAll() {
    for (const tail of this.tails) tail.stop();
    this.finishFadeIn();
  }

  /** The volume the user has set (not the momentary faded level). */
  private userVolume() {
    return this.target ?? (volumeDesc.get!.call(this.video) as number);
  }

  /**
   * The player drops the current song by calling `removeAttribute('src')`
   * (or assigning a new `src`) on the <video>, synchronously, while it is
   * still playing. That's the exact moment to take over with the mirror.
   */
  private hookTeardown() {
    const { video } = this;
    const srcDesc = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'src',
    )!;
    // oxlint-disable-next-line typescript/unbound-method
    const removeAttribute = Element.prototype.removeAttribute;

    video.removeAttribute = (name: string) => {
      if (name.toLowerCase() === 'src') this.onTeardown();
      removeAttribute.call(video, name);
    };
    Object.defineProperty(video, 'src', {
      configurable: true,
      get: () => srcDesc.get!.call(video) as string,
      set: (value: string) => {
        this.onTeardown();
        srcDesc.set!.call(video, value);
      },
    });
  }

  private onTeardown() {
    const prerolled = this.takePreroll();
    let tailStarted = false;
    try {
      const { video } = this;
      const auto = performance.now() - this.autoSkipAt < AUTO_SKIP_WINDOW;
      this.autoSkipAt = -Infinity;
      const jump =
        this.jump && performance.now() - this.jump.at < JUMP_WINDOW
          ? this.jump
          : undefined;
      this.jump = undefined;

      // Song changed while paused: whatever was fading is stale now.
      if (this.userPaused) {
        this.cancelAll();
        return;
      }
      // Still loading the previous change (rapid skips): nothing is audible
      // from the player; keep the running fades as they are.
      if (video.paused || video.ended) return;

      const settings = this.getSettings();
      const enabled = jump
        ? true
        : auto
          ? settings.autoEnabled
          : settings.manualEnabled;
      if (!enabled) {
        this.finishFadeIn();
        return;
      }
      const fade = jump
        ? jump.duration
        : this.fadeLength(
            auto ? settings.autoDuration : settings.manualDuration,
          );

      const mirror = this.mirrors.current;
      const time = video.currentTime;
      if (!mirror?.covers(time)) {
        this.finishFadeIn();
        return;
      }

      const duration = Number.isFinite(video.duration)
        ? video.duration
        : Infinity;
      const songEnd = this.songEnd(
        Math.min(mirror.songEndAt(time), duration),
        time,
      );
      const tailLength = Math.min(fade, songEnd - time);
      if (!(tailLength > 0.3)) {
        this.finishFadeIn();
        return;
      }

      // Actual audible level now (may be mid fade-in) and the user's volume.
      const startVolume = volumeDesc.get!.call(video) as number;
      const target = this.userVolume();

      this.mirrors.release();
      // It keeps its loudness level on its own element.
      this.handOff?.(mirror.audio);
      tailStarted = true;
      const outgoing = this.playing;
      const tempo = outgoing && tempoCache.get(outgoing.videoId);
      this.beatSync =
        outgoing && tempo
          ? {
              audio: mirror.audio,
              tempo,
              shift: outgoing.shift,
              baseRate: video.playbackRate,
              attempts: 0,
              bentAt: 0,
              skipped: 0,
            }
          : undefined;
      this.playTail(mirror, {
        time,
        startVolume,
        userVolumeAtStart: target,
        length: tailLength,
        curve: fadeFor(settings),
        playbackRate: video.playbackRate,
      });
      this.startFadeIn(target, fade, fadeFor(settings), jump?.startAt);
    } catch (err) {
      console.warn('[seamless-crossfade]', err);
    } finally {
      // Prerolled but not used after all: stop it.
      if (prerolled && !tailStarted) prerolled.pause();
    }
  }

  /** Play the outgoing song from the mirror, fading it out. */
  private playTail(
    mirror: StreamMirror,
    options: {
      time: number;
      startVolume: number;
      userVolumeAtStart: number;
      length: number;
      curve: Fade;
      playbackRate: number;
    },
  ) {
    const { audio } = mirror;
    const { video } = this;
    let cancel: (() => void) | undefined;
    const tail: Tail = {
      pause: () => audio.pause(),
      resume: () => {
        audio.play().catch(() => tail.stop());
      },
      stop: () => {
        cancel?.();
        if (this.beatSync?.audio === audio) this.beatSync = undefined;
        mirror.dispose();
        this.tails.delete(tail);
      },
    };
    this.tails.add(tail);

    audio.playbackRate = options.playbackRate;
    // Bending its tempo to the next song's keeps its pitch.
    audio.preservesPitch = true;
    // Already playing in step (prerolled): don't restart it.
    if (audio.paused) audio.currentTime = options.time;
    if (video.sinkId) {
      audio.setSinkId(video.sinkId).catch(() => {});
    }

    const volumeAt = (progress: number) => {
      // Follow the player's volume slider and mute while fading.
      const scale =
        options.userVolumeAtStart > 0
          ? this.userVolume() / options.userVolumeAtStart
          : 0;
      const value =
        options.startVolume * scale * options.curve.out(progress);
      return Math.min(1, Math.max(0, value));
    };

    let elapsed = 0;
    let last = performance.now();
    let progress = 0;
    audio.volume = volumeAt(0);
    audio.muted = video.muted;
    cancel = loop((now) => {
      // The fade only advances while the outgoing song actually plays.
      if (!audio.paused) elapsed += now - last;
      this.steer(audio);
      last = now;
      const own = Math.min(1, elapsed / 1000 / options.length);
      progress = Math.max(progress, this.outgoingProgress(options.curve, own));
      audio.muted = video.muted;
      audio.volume = volumeAt(progress);
      if (progress < 1 && !audio.ended) return true;
      tail.stop();
      return false;
    });

    if (this.userPaused) return;
    audio.play().catch(() => tail.stop());
  }

  /** Keep the incoming song silent until it plays, then fade it in. */
  private startFadeIn(
    target: number,
    duration: number,
    curve: Fade,
    /** Stay silent until the new song is at this position (Play from…). */
    startAt?: number,
  ) {
    const { video } = this;
    this.target = target;
    this.fadeIn = { waited: 0, duration, curve };
    this.incomingProgress = undefined;
    this.cancelFadeIn?.();
    this.holdVolume();
    setVolume(video, 0);

    let last = performance.now();
    this.cancelFadeIn = loop((now) => {
      const fadeIn = this.fadeIn;
      if (!fadeIn) return false;
      const dt = now - last;
      last = now;

      // "Play from…" or a queued song with a chosen start: stay silent
      // until it has jumped there.
      const videoId = this.api.getVideoData()?.video_id;
      const target =
        startAt ??
        this.scheduledStart?.(videoId) ??
        this.partStart?.(videoId);
      const positioned =
        target === undefined || this.api.getCurrentTime() >= target - 1;
      const playing =
        !video.paused &&
        !video.seeking &&
        video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
        positioned;

      if (fadeIn.elapsed === undefined) {
        // Still silent: first move it onto the outgoing song's beat.
        if (playing && this.alignBeats()) {
          setVolume(video, 0);
          return true;
        }
        if (playing) {
          fadeIn.elapsed = 0;
        } else {
          // Nothing started (end of queue, autoplay off…): give up, but
          // don't count time the user spent paused.
          if (!this.userPaused) fadeIn.waited += dt;
          if (fadeIn.waited > NEXT_SONG_TIMEOUT) {
            this.finishFadeIn();
            return false;
          }
          setVolume(video, 0);
          return true;
        }
      } else if (playing) {
        fadeIn.elapsed += dt;
      }

      const progress = Math.min(1, fadeIn.elapsed / 1000 / fadeIn.duration);
      this.incomingProgress = progress;
      setVolume(video, this.userVolume() * fadeIn.curve.in(progress));
      if (progress < 1) return true;
      this.finishFadeIn();
      return false;
    });
  }

  /**
   * While fading in, the player keeps writing `video.volume` (e.g. when it
   * loads the new song or the user moves the slider). Treat those writes as
   * the new target volume instead of letting them jump the song to full
   * volume, and keep reporting the user's volume back to the player so its
   * own state never sees the faded level.
   */
  private holdVolume() {
    const { video } = this;
    if (Object.prototype.hasOwnProperty.call(video, 'volume')) return;
    Object.defineProperty(video, 'volume', {
      configurable: true,
      get: () => this.userVolume(),
      set: (value: number) => {
        this.target = value;
      },
    });
  }

  private finishFadeIn() {
    this.cancelFadeIn?.();
    this.cancelFadeIn = undefined;
    this.fadeIn = undefined;
    // Cut short: outgoing songs go back to their own clock.
    if ((this.incomingProgress ?? 0) < 1) this.incomingProgress = undefined;
    if (this.target === undefined) return;
    const target = this.target;
    this.target = undefined;
    Reflect.deleteProperty(this.video, 'volume');
    this.video.volume = target;
    // Let the player re-apply its own volume (normalisation etc.).
    this.api.setVolume(this.api.getVolume());
  }

  private readonly onPause = () => {
    // A song change doesn't fire `pause` (and has no src at that point);
    // this is the user pausing: freeze the outgoing songs with the player.
    if (!this.video.getAttribute('src')) return;
    this.userPaused = true;
    for (const tail of this.tails) tail.pause();
  };

  private readonly onPlay = () => {
    this.userPaused = false;
    for (const tail of this.tails) tail.resume();
  };

  /**
   * Where the outgoing fade is: its own clock, or (curves that follow the
   * incoming song) the incoming song's progress, holding while that one
   * is still silent (its own clock again if nothing comes in).
   */
  private outgoingProgress(curve: Fade, own: number) {
    if (!curve.followsIncoming) return own;
    if (this.incomingProgress !== undefined) return this.incomingProgress;
    return this.fadeIn ? 0 : own;
  }

  /**
   * The incoming song plays (still silent): skip it ahead by less than a
   * beat so its beats fall on the outgoing song's. True while a seek for
   * that is under way (stay silent until it's done).
   */
  private alignBeats() {
    const sync = this.beatSync;
    if (!sync || sync.attempts >= ALIGN_ATTEMPTS || sync.audio.paused) {
      return false;
    }
    if (!sync.lock) {
      const videoId = this.api.getVideoData()?.video_id;
      const incoming = videoId ? tempoCache.get(videoId) : undefined;
      const inTime = this.api.getCurrentTime();
      const outTime = sync.audio.currentTime - sync.shift;
      const inGrid = incoming && beatGrid(incoming, inTime, inTime + 10);
      const outGrid = beatGrid(sync.tempo, outTime - 6, outTime + 4);
      if (!inGrid || !outGrid) {
        this.beatSync = undefined;
        return false;
      }
      // The closest of same, half and double time.
      const ratio = [0.5, 1, 2]
        .map((times) => (outGrid.period * times) / inGrid.period)
        .reduce((a, b) => (Math.abs(b - 1) < Math.abs(a - 1) ? b : a));
      sync.lock = {
        out: outGrid,
        in: inGrid,
        ratio,
        bend: Math.abs(ratio - 1) <= MAX_BEND,
        incoming,
      };
    }
    const { lock } = sync;
    const rate = sync.audio.playbackRate / sync.baseRate;
    const inTime = this.api.getCurrentTime();
    const outTime = sync.audio.currentTime - sync.shift;
    // The outgoing song's beats as they will play (bent or not).
    const outPeriod = lock.out.period / (lock.bend ? lock.ratio : rate);
    const grid = Math.min(lock.in.period, outPeriod);
    // First its bars onto the outgoing song's (same tempo only): forward,
    // less than a bar.
    if (!sync.barsDone) {
      sync.barsDone = true;
      const outBar = lock.bend ? toNextBar(sync.tempo, outTime) : undefined;
      const inBar =
        outBar === undefined ? undefined : toNextBar(lock.incoming, inTime);
      if (outBar !== undefined && inBar !== undefined) {
        sync.barsAligned = true;
        const delta = mod(inBar - (outBar / rate), lock.in.period * BAR);
        if (delta > 0.015) {
          this.video.currentTime += delta;
          return true;
        }
      }
    }
    // Then onto its beats: forward only (it starts a little early), or
    // either way once the bars are lined up (so they stay lined up).
    const ahead = mod(
      toNextBeat(lock.in, inTime) - (toNextBeat(lock.out, outTime) / rate),
      grid,
    );
    const delta = sync.barsAligned ? wrap(ahead, grid) : ahead;
    // Close enough, or it would skip more than about a beat in all.
    if (Math.abs(delta) < 0.015 || grid - delta < 0.015) return false;
    if (sync.skipped + Math.abs(delta) > grid * 1.25) return false;
    sync.attempts++;
    sync.skipped += Math.abs(delta);
    this.video.currentTime += delta;
    return true;
  }

  /**
   * Keep the outgoing song on the incoming one's beat: play it at the
   * incoming song's tempo (when close enough), a little faster or slower
   * while its beats drift ahead or behind.
   */
  private steer(audio: HTMLAudioElement) {
    const sync = this.beatSync;
    const lock = sync?.lock;
    if (!sync || sync.audio !== audio || !lock?.bend) return;
    if (audio.paused || this.video.paused || this.video.seeking) return;
    const now = performance.now();
    if (now - sync.bentAt < BEND_INTERVAL) return;
    const seconds = sync.bentAt ? (now - sync.bentAt) / 1000 : BEND_INTERVAL / 1000;
    const rate = audio.playbackRate / sync.baseRate;
    const grid = Math.min(lock.in.period, lock.out.period / lock.ratio);
    const outTime = audio.currentTime - sync.shift;
    const inTime = this.api.getCurrentTime();
    // Positive: its beat comes later than the incoming one's (speed up).
    let offset = wrap(
      (toNextBeat(lock.out, outTime) / rate) - toNextBeat(lock.in, inTime),
      grid,
    );
    if (Math.abs(offset) < BEAT_TOLERANCE) offset = 0;
    const wanted = lock.ratio * (1 + clamp(offset * NUDGE_GAIN, MAX_NUDGE));
    const next = rate + clamp(wanted - rate, BEND_SLEW * seconds);
    // Not for tiny changes (except to land exactly on the tempo).
    if (Math.abs(next - rate) < Math.min(BEND_STEP, Math.abs(wanted - rate))) {
      return;
    }
    if (Math.abs(next - rate) < 0.0005) return;
    sync.bentAt = now;
    audio.playbackRate = sync.baseRate * next;
  }

  /**
   * How long a crossfade out of the playing song lasts: a number of its
   * beats when its tempo is known (and that's the setting), else `seconds`.
   */
  private fadeLength(seconds: number) {
    const settings = this.getSettings();
    if (!settings.fadeInBeats) return seconds;
    const videoId = this.playing?.videoId;
    const tempo = videoId ? tempoCache.get(videoId) : undefined;
    if (!tempo) return seconds;
    return clampDuration((settings.fadeBeats * 60) / tempo.bpm);
  }

  /**
   * Remember the playing song (for the next crossfade) and have the next
   * song's tempo ready by then.
   */
  private notePlaying() {
    const { video, api } = this;
    const videoId = api.getVideoData()?.video_id;
    if (!videoId) return;
    this.playing = {
      videoId,
      shift: video.currentTime - api.getCurrentTime(),
    };
    const next = nextInQueue();
    if (!next || next === this.prefetched) return;
    this.prefetched = next;
    loadTempo(next).catch(() => {});
  }

  /** Automatic crossfade: skip `autoDuration` seconds before the song ends. */
  private readonly onTimeUpdate = () => {
    const { video, api } = this;
    if (video.paused) return;
    this.notePlaying();

    const settings = this.getSettings();
    const chosenEnd = this.intervalEnd?.(api.getVideoData()?.video_id);
    // A chosen end without automatic crossfade: just move on there.
    if (chosenEnd !== undefined && !settings.autoEnabled) {
      const songTime = api.getCurrentTime();
      if (songTime >= chosenEnd && songTime < chosenEnd + 2) this.skip();
      return;
    }
    if (!settings.autoEnabled) return;

    const mirror = this.mirrors.current;
    if (!mirror) return;

    const fade = this.fadeLength(settings.autoDuration);
    const time = video.currentTime;
    const songStart = time - api.getCurrentTime();
    const end = this.songEnd(
      Math.min(mirror.songEndAt(time), video.duration),
      time,
    );
    if (!Number.isFinite(end)) return;

    // A chosen part may be short: crossfade anyway.
    const minimumSong = chosenEnd === undefined ? fade * 2 : 0;
    if (end - songStart < minimumSong) return;
    const remaining = end - time;
    const lookahead = fade + PREROLL_LEAD + ALIGN_EARLY_MAX;
    if (remaining > lookahead || remaining < 0.5) return;

    const key = `${api.getVideoData()?.video_id}@${songStart.toFixed(1)}`;
    if (key === this.autoSkippedFor) return;
    // Where it starts: on a phrase (or bar) start near `end - fade`.
    if (this.skipPlan?.key !== key) {
      this.skipPlan = {
        key,
        at: this.alignedStart(end - fade, songStart, time + PREROLL_LEAD),
      };
    }
    const skipAt = this.skipPlan.at;
    if (time < skipAt - PREROLL_LEAD) return;
    if (getRepeatMode() === 'ONE') return;
    if (!mirror.covers(time, end - time - 0.3)) return;

    this.autoSkippedFor = key;
    this.prerollThenSkip(mirror, skipAt);
  };

  /**
   * Media time to start an automatic crossfade planned at `planned`: the
   * playing song's closest phrase start around it, else its closest bar
   * start, else beat (never before `notBefore`).
   */
  private alignedStart(planned: number, songStart: number, notBefore: number) {
    const videoId = this.playing?.videoId;
    const tempo = videoId ? tempoCache.get(videoId) : undefined;
    if (!tempo) return planned;
    const beat = 60 / tempo.bpm;
    const time = planned - songStart;
    const earliest = Math.max(
      time - Math.min(ALIGN_EARLY_BEATS * beat, ALIGN_EARLY_MAX),
      notBefore - songStart,
    );
    const latest = time + (ALIGN_LATE_BEATS * beat);
    const closest = (times: number[]) =>
      times.length
        ? times.reduce((a, b) =>
            Math.abs(b - time) < Math.abs(a - time) ? b : a,
          )
        : undefined;
    const found =
      closest(marksBetween(tempo, earliest, latest, PHRASE)) ??
      closest(
        marksBetween(tempo, Math.max(earliest, time - (BAR * beat)), latest, BAR),
      ) ??
      closest(marksBetween(tempo, time - (beat / 2), time + (beat / 2), 1));
    return found === undefined ? planned : songStart + found;
  }

  /**
   * Start the outgoing song's mirror muted, get it in step with the player
   * (catching up by playing a little faster or slower while muted), then
   * skip once it's in step and the fade is due (`skipAt`, media time).
   */
  private prerollThenSkip(mirror: StreamMirror, skipAt: number) {
    const { video } = this;
    const { audio } = mirror;
    this.takePreroll()?.pause();
    audio.muted = true;
    audio.volume = 0;
    audio.preservesPitch = true;
    audio.playbackRate = video.playbackRate;
    audio.currentTime = video.currentTime;
    audio.play().catch(() => {});
    const started = performance.now();
    const skip = () => {
      cancel();
      this.preroll = undefined;
      audio.playbackRate = video.playbackRate;
      this.autoSkipAt = performance.now();
      this.skip();
    };
    const cancel = loop((now) => {
      // Paused or moved meanwhile: drop it (the next timeupdate decides).
      if (video.paused || video.seeking || this.mirrors.current !== mirror) {
        this.takePreroll()?.pause();
        this.autoSkippedFor = undefined;
        return false;
      }
      const late = now - started > PREROLL_TIMEOUT;
      const due = video.currentTime >= skipAt;
      if (audio.paused || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        if (late) skip();
        return !late;
      }
      // Positive: the mirror is ahead.
      const drift = audio.currentTime - video.currentTime;
      const inStep = Math.abs(drift) < PREROLL_TOLERANCE;
      if ((inStep && due) || late) {
        skip();
        return false;
      }
      audio.playbackRate =
        video.playbackRate * (inStep ? 1 : 1 - clamp(drift * 3, 0.3));
      return true;
    });
    this.preroll = { audio, cancel };
  }

  /** Stop getting a preroll in step; returns its audio if there was one. */
  private takePreroll() {
    const preroll = this.preroll;
    this.preroll = undefined;
    preroll?.cancel();
    return preroll?.audio;
  }

  /**
   * Go to the next song through the UI button: it uses YouTube Music's
   * queue logic (radio/automix items that aren't loaded yet), which
   * api.nextVideo() bypasses. The teardown hook does the crossfade.
   */
  private skip() {
    const nextButton =
      document.querySelector<HTMLButtonElement>('.next-button');
    if (nextButton) nextButton.click();
    else this.api.nextVideo();
  }

  /**
   * The player's stream may have started before our hooks were installed,
   * in which case there's nothing to mirror. Reload the song once (at the
   * same position) so it goes through a hooked MediaSource.
   */
  private readonly ensureMirrored = () => {
    if (this.reloadChecked) return;
    this.reloadChecked = true;
    if (this.mirrors.current) return;
    const videoId = this.api.getVideoData()?.video_id;
    if (!videoId) return;
    this.api.loadVideoById(
      videoId,
      this.api.getCurrentTime(),
      this.api.getUserPlaybackQualityPreference(),
    );
  };
}

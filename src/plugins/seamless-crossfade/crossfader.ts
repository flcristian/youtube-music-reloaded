import {
  curves,
  type FadeCurve,
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
    curve: FadeCurve;
  };
  private cancelFadeIn?: () => void;
  /** Paused by the user (as opposed to the player loading a new song). */
  private userPaused = false;
  private autoSkippedFor?: string;
  private autoSkipAt = -Infinity;
  /** A "Play from…" in progress: crossfade with its own duration. */
  private jump?: { at: number; duration: number; startAt: number };
  private reloadChecked = false;

  constructor(
    private readonly api: MusicPlayer,
    private readonly video: HTMLVideoElement,
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
        : auto
          ? settings.autoDuration
          : settings.manualDuration;

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
      this.playTail(mirror, {
        time,
        startVolume,
        userVolumeAtStart: target,
        length: tailLength,
        curve: settings.curve,
        playbackRate: video.playbackRate,
      });
      this.startFadeIn(target, fade, settings.curve, jump?.startAt);
    } catch (err) {
      console.warn('[seamless-crossfade]', err);
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
      curve: FadeCurve;
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
        mirror.dispose();
        this.tails.delete(tail);
      },
    };
    this.tails.add(tail);

    audio.playbackRate = options.playbackRate;
    audio.currentTime = options.time;
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
        options.startVolume * scale * curves[options.curve].out(progress);
      return Math.min(1, Math.max(0, value));
    };

    let elapsed = 0;
    let last = performance.now();
    audio.volume = volumeAt(0);
    audio.muted = video.muted;
    cancel = loop((now) => {
      // The fade only advances while the outgoing song actually plays.
      if (!audio.paused) elapsed += now - last;
      last = now;
      const progress = Math.min(1, elapsed / 1000 / options.length);
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
    curve: FadeCurve,
    /** Stay silent until the new song is at this position (Play from…). */
    startAt?: number,
  ) {
    const { video } = this;
    this.target = target;
    this.fadeIn = { waited: 0, duration, curve };
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
      const target =
        startAt ?? this.scheduledStart?.(this.api.getVideoData()?.video_id);
      const positioned =
        target === undefined || this.api.getCurrentTime() >= target - 1;
      const playing =
        !video.paused &&
        video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
        positioned;

      if (fadeIn.elapsed === undefined) {
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
      setVolume(video, this.userVolume() * curves[fadeIn.curve].in(progress));
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

  /** Automatic crossfade: skip `autoDuration` seconds before the song ends. */
  private readonly onTimeUpdate = () => {
    const { video, api } = this;
    if (video.paused) return;

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

    const fade = settings.autoDuration;
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
    if (remaining > fade || remaining < 0.5) return;

    const key = `${api.getVideoData()?.video_id}@${songStart.toFixed(1)}`;
    if (key === this.autoSkippedFor) return;
    if (getRepeatMode() === 'ONE') return;
    if (!mirror.covers(time, remaining - 0.3)) return;

    this.autoSkippedFor = key;
    this.autoSkipAt = performance.now();
    this.skip();
  };

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

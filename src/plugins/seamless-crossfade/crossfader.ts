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
 */
export class Crossfader {
  private readonly tails = new Set<Tail>();
  /** The real (user) volume while a fade-in is running. */
  private target?: number;
  private fadeIn?: {
    since: number;
    startedAt?: number;
    duration: number;
    curve: FadeCurve;
  };
  private cancelFadeIn?: () => void;
  private autoSkippedFor?: string;
  private autoSkipAt = -Infinity;
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
    video.addEventListener('playing', this.ensureMirrored);
    this.hookTeardown();
    if (!video.paused) this.ensureMirrored();
  }

  detach() {
    const { video } = this;
    video.removeEventListener('timeupdate', this.onTimeUpdate);
    video.removeEventListener('pause', this.onPause);
    video.removeEventListener('playing', this.ensureMirrored);
    // Remove the instance-level overrides, falling back to the prototype.
    Reflect.deleteProperty(video, 'removeAttribute');
    Reflect.deleteProperty(video, 'src');
    for (const tail of this.tails) tail.stop();
    this.finishFadeIn();
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
      const settings = this.getSettings();
      if (!(auto ? settings.autoEnabled : settings.manualEnabled)) return;
      const fade = auto ? settings.autoDuration : settings.manualDuration;

      if (video.paused || video.ended) return;

      const mirror = this.mirrors.current;
      const time = video.currentTime;
      if (!mirror?.covers(time)) return;

      const duration = Number.isFinite(video.duration)
        ? video.duration
        : Infinity;
      const songEnd = Math.min(mirror.songEndAt(time), duration);
      const tailLength = Math.min(fade, songEnd - time);
      if (!(tailLength > 0.3)) return;

      const startVolume = video.volume;
      const target = this.target ?? video.volume;

      this.mirrors.release();
      this.playTail(mirror, time, startVolume, tailLength, settings.curve);
      this.startFadeIn(target, fade, settings.curve);
    } catch (err) {
      console.warn('[seamless-crossfade]', err);
    }
  }

  /** Play the outgoing song from the mirror, fading it out. */
  private playTail(
    mirror: StreamMirror,
    time: number,
    volume: number,
    length: number,
    curve: FadeCurve,
  ) {
    const { audio } = mirror;
    let cancel: (() => void) | undefined;
    const tail: Tail = {
      stop: () => {
        cancel?.();
        mirror.dispose();
        this.tails.delete(tail);
      },
    };
    this.tails.add(tail);

    audio.volume = volume;
    audio.currentTime = time;
    if (this.video.sinkId) {
      audio.setSinkId(this.video.sinkId).catch(() => {});
    }

    const begin = performance.now();
    cancel = loop((now) => {
      const progress = Math.min(1, (now - begin) / 1000 / length);
      audio.volume = Math.min(
        1,
        Math.max(0, volume * curves[curve].out(progress)),
      );
      if (progress < 1) return true;
      tail.stop();
      return false;
    });
    audio.play().catch(() => tail.stop());
  }

  /** Keep the incoming song silent until it plays, then fade it in. */
  private startFadeIn(target: number, duration: number, curve: FadeCurve) {
    const { video } = this;
    this.target = target;
    this.fadeIn = { since: performance.now(), duration, curve };
    this.cancelFadeIn?.();
    this.holdVolume();
    setVolume(video, 0);

    this.cancelFadeIn = loop((now) => {
      const fadeIn = this.fadeIn;
      if (!fadeIn) return false;

      if (fadeIn.startedAt === undefined) {
        const playing =
          !video.paused &&
          video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
        if (playing) {
          fadeIn.startedAt = now;
        } else if (now - fadeIn.since > NEXT_SONG_TIMEOUT) {
          this.finishFadeIn();
          return false;
        } else {
          setVolume(video, 0);
          return true;
        }
      }

      const progress = Math.min(
        1,
        (now - fadeIn.startedAt) / 1000 / fadeIn.duration,
      );
      setVolume(
        video,
        (this.target ?? target) * curves[fadeIn.curve].in(progress),
      );
      if (progress < 1) return true;
      this.finishFadeIn();
      return false;
    });
  }

  /**
   * While fading in, the player keeps writing `video.volume` (e.g. when it
   * loads the new song). Treat those writes as the new target volume
   * instead of letting them jump the song to full volume.
   */
  private holdVolume() {
    const { video } = this;
    if (Object.prototype.hasOwnProperty.call(video, 'volume')) return;
    Object.defineProperty(video, 'volume', {
      configurable: true,
      get: () => volumeDesc.get!.call(video) as number,
      set: (value: number) => {
        this.target = value;
      },
    });
  }

  private finishFadeIn() {
    this.cancelFadeIn?.();
    this.cancelFadeIn = undefined;
    if (this.target === undefined) return;
    Reflect.deleteProperty(this.video, 'volume');
    this.video.volume = this.target;
    this.target = undefined;
    this.fadeIn = undefined;
    // Let the player re-apply its own volume (normalisation etc.).
    this.api.setVolume(this.api.getVolume());
  }

  private readonly onPause = () => {
    // A user pause (not a song change, which doesn't fire `pause`):
    // silence the outgoing song and settle the incoming one.
    if (!this.video.getAttribute('src')) return;
    for (const tail of this.tails) tail.stop();
    if (this.fadeIn?.startedAt !== undefined) this.finishFadeIn();
  };

  /** Automatic crossfade: skip `autoDuration` seconds before the song ends. */
  private readonly onTimeUpdate = () => {
    const { video, api } = this;
    if (video.paused) return;

    const settings = this.getSettings();
    if (!settings.autoEnabled) return;

    const mirror = this.mirrors.current;
    if (!mirror) return;

    const fade = settings.autoDuration;
    const time = video.currentTime;
    const songStart = time - api.getCurrentTime();
    const end = Math.min(mirror.songEndAt(time), video.duration);
    if (!Number.isFinite(end)) return;

    const minimumSong = fade * 2;
    if (end - songStart < minimumSong) return;
    const remaining = end - time;
    if (remaining > fade || remaining < 0.5) return;

    const key = `${api.getVideoData()?.video_id}@${songStart.toFixed(1)}`;
    if (key === this.autoSkippedFor) return;
    if (getRepeatMode() === 'ONE') return;
    if (!mirror.covers(time, remaining - 0.3)) return;

    this.autoSkippedFor = key;
    this.autoSkipAt = performance.now();
    // Go through the UI button: it uses YouTube Music's queue logic
    // (radio/automix items that aren't loaded yet), which
    // api.nextVideo() bypasses. The teardown hook does the crossfade.
    const nextButton =
      document.querySelector<HTMLButtonElement>('.next-button');
    if (nextButton) nextButton.click();
    else api.nextVideo();
  };

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

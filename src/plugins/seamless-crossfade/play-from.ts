/**
 * "Play from…" in a song's menu: pick a point on the song's waveform and
 * start playing it from there, crossfading from the current song.
 */
import { t } from '@/i18n';
import { drawWaveform } from '@/plugins/waveform-seekbar/draw';
import { loadPeaks } from '@/plugins/waveform-seekbar/peaks';

import type { MusicPlayer } from '@/types/music-player';

declare const ytcfg: { get: (key: string) => unknown };

interface SongDetails {
  title: string;
  length: number;
  thumbnail?: string;
}

interface WatchEndpoint {
  videoId: string;
  [key: string]: unknown;
}

const key = (name: string) => `plugins.seamless-crossfade.play-from.${name}`;

const formatTime = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
};

/** Title, length and cover of any song, from YouTube Music's own API. */
const fetchDetails = async (videoId: string): Promise<SongDetails> => {
  const response = await fetch('/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      context: ytcfg.get('INNERTUBE_CONTEXT'),
      videoId,
    }),
  });
  const json = (await response.json()) as {
    videoDetails?: {
      title?: string;
      lengthSeconds?: string;
      thumbnail?: { thumbnails?: { url: string; width: number }[] };
    };
  };
  const details = json.videoDetails ?? {};
  const thumbnails = details.thumbnail?.thumbnails ?? [];
  const largest = thumbnails.reduce<(typeof thumbnails)[number] | undefined>(
    (best, it) => (!best || it.width > best.width ? it : best),
    undefined,
  );
  return {
    title: details.title ?? '',
    length: Number(details.lengthSeconds) || 0,
    thumbnail: largest?.url,
  };
};

/** The song a menu belongs to, from its "Play next"/"Add to queue" item. */
const menuVideoId = (listbox: Element) => {
  for (const item of listbox.children) {
    const data = (item as HTMLElement & { data?: unknown }).data as
      | {
          serviceEndpoint?: {
            queueAddEndpoint?: { queueTarget?: { videoId?: string } };
          };
        }
      | undefined;
    const videoId =
      data?.serviceEndpoint?.queueAddEndpoint?.queueTarget?.videoId;
    if (videoId) return videoId;
  }
  return undefined;
};

type InsertPosition = 'INSERT_AFTER_CURRENT_VIDEO' | 'INSERT_AT_END';

/** The menu's "Play next" or "Add to queue" item. */
const queueItem = (listbox: Element, position: InsertPosition) =>
  [...listbox.children].find((item) => {
    const data = (item as HTMLElement & { data?: unknown }).data as
      | {
          serviceEndpoint?: {
            queueAddEndpoint?: { queueInsertPosition?: string };
          };
        }
      | undefined;
    return (
      data?.serviceEndpoint?.queueAddEndpoint?.queueInsertPosition === position
    );
  }) as (HTMLElement & { data?: unknown }) | undefined;

/** Part of a song to play, in song seconds; no `end`: until the end. */
interface Interval {
  start: number;
  end?: number;
}

/** Shortest part of a song that can be chosen, in seconds. */
const MIN_INTERVAL = 5;

/** How long to wait for the chosen song to load, in ms. */
const ENSURE_TIMEOUT = 10_000;
/**
 * Whether playback is at the chosen start: not before it, and not far
 * past it (it keeps moving forward while we check).
 */
const nearStart = (time: number, start: number) =>
  time >= start - 1.5 && time <= start + 10;

/** How long the song must stay at the chosen start to be done, in ms. */
const SETTLE_TIME = 1000;

const ICON = 'M8 5v14l11-7z M3 3h2v18H3z';

export class PlayFrom {
  private observer?: MutationObserver;
  private menuItem?: HTMLElement;
  private menuVideoId?: string;
  /** The menu's own "Play next" / "Add to queue" actions (their data). */
  private menuQueueData: Partial<Record<InsertPosition, unknown>> = {};
  /** Queued songs and the part of them to play (song seconds). */
  private readonly scheduled = new Map<string, Interval>();
  /** "Play from…" (play now): the next song that starts is the chosen one. */
  private playNow?: { interval: Interval; key: string; at: number };
  /** The playing song's chosen end, once it has started. */
  private activeEnd?: { videoId: string; end: number };
  private lastVideoId?: string;
  private video?: HTMLVideoElement;
  private modal?: HTMLElement;
  private cancelEnsure?: () => void;

  constructor(
    private readonly api: MusicPlayer,
    private readonly prepareCrossfade: (startAt: number) => void,
  ) {}

  install() {
    const container = document.querySelector('ytmusic-popup-container');
    if (!container) return;
    this.menuItem = this.createMenuItem();
    this.observer = new MutationObserver(() => this.addToMenu());
    this.observer.observe(container, { childList: true, subtree: true });

    this.video = document.querySelector('video') ?? undefined;
    this.lastVideoId = this.api.getVideoData()?.video_id;
    for (const event of ['loadeddata', 'playing', 'timeupdate']) {
      this.video?.addEventListener(event, this.onSongProgress);
    }
  }

  /** Start position for a queued song, while it is waiting to start. */
  scheduledStart(videoId: string | undefined) {
    if (videoId === undefined) return undefined;
    if (this.playNow && performance.now() - this.playNow.at < ENSURE_TIMEOUT) {
      return this.playNow.interval.start;
    }
    return this.findScheduled(videoId)?.interval.start;
  }

  /**
   * The scheduled entry for the playing song. Songs can play under another
   * id than the one in their menu (song vs. music video version), so also
   * look at every id in the playing song's queue entry.
   */
  private findScheduled(videoId: string) {
    const direct = this.scheduled.get(videoId);
    if (direct) return { key: videoId, interval: direct };
    if (!this.scheduled.size) return undefined;
    const ids = new Set<string>();
    for (const item of document.querySelectorAll<
      HTMLElement & { data?: unknown }
    >('ytmusic-player-queue-item')) {
      const entry =
        item.closest<HTMLElement & { data?: unknown }>(
          'ytmusic-playlist-panel-video-wrapper-renderer',
        ) ?? item;
      const json = JSON.stringify(entry.data ?? item.data ?? {});
      if (!json.includes(`"${videoId}"`)) continue;
      for (const match of json.matchAll(/"videoId":"([\w-]+)"/g)) {
        ids.add(match[1]);
      }
    }
    for (const [key, interval] of this.scheduled) {
      if (ids.has(key)) return { key, interval };
    }
    return undefined;
  }

  /** Where the playing song should end (crossfading into the next). */
  intervalEnd(videoId: string | undefined) {
    const active = this.activeEnd;
    return active && active.videoId === videoId ? active.end : undefined;
  }

  /** When a queued song starts, jump to the chosen moment. */
  private readonly onSongProgress = () => {
    const videoId = this.api.getVideoData()?.video_id;
    if (!videoId || videoId === this.lastVideoId) return;
    if (!(this.api.getDuration() > 0)) return;
    this.lastVideoId = videoId;
    let found: { key: string; interval: Interval } | undefined;
    const playNow = this.playNow;
    this.playNow = undefined;
    if (playNow && performance.now() - playNow.at < ENSURE_TIMEOUT) {
      found = playNow;
    } else {
      found = this.findScheduled(videoId);
    }
    const interval = found?.interval;
    if (interval) {
      this.activeEnd =
        interval.end === undefined ? undefined : { videoId, end: interval.end };
    } else if (this.activeEnd?.videoId !== videoId) {
      this.activeEnd = undefined;
    }
    if (!found || !interval) return;
    this.scheduled.delete(found.key);
    this.ensurePosition(videoId, interval.start);
  };

  uninstall() {
    this.observer?.disconnect();
    this.menuItem?.remove();
    this.closeModal();
    this.cancelEnsure?.();
    for (const event of ['loadeddata', 'playing', 'timeupdate']) {
      this.video?.removeEventListener(event, this.onSongProgress);
    }
  }

  private addToMenu() {
    const listbox = document.querySelector(
      'ytmusic-menu-popup-renderer tp-yt-paper-listbox',
    );
    const item = this.menuItem;
    if (!listbox || !item) return;
    const videoId = menuVideoId(listbox);
    if (!videoId) {
      item.remove();
      return;
    }
    this.menuVideoId = videoId;
    this.menuQueueData = {
      INSERT_AFTER_CURRENT_VIDEO: queueItem(
        listbox,
        'INSERT_AFTER_CURRENT_VIDEO',
      )?.data,
      INSERT_AT_END: queueItem(listbox, 'INSERT_AT_END')?.data,
    };
    const after = queueItem(listbox, 'INSERT_AT_END');
    if (
      item.parentElement === listbox &&
      item.previousElementSibling === after
    ) {
      return;
    }
    if (after) after.after(item);
    else listbox.append(item);
  }

  private createMenuItem() {
    const item = document.createElement('div');
    item.setAttribute('role', 'option');
    item.tabIndex = -1;
    item.className = 'style-scope ytmusic-menu-popup-renderer';
    Object.assign(item.style, {
      display: 'flex',
      alignItems: 'center',
      height: '48px',
      padding: '0 16px',
      cursor: 'pointer',
      color: 'var(--ytmusic-text-primary, #fff)',
      fontSize: '14px',
    });
    item.innerHTML = `
      <svg viewBox="0 0 24 24" width="24" height="24" style="margin-right:16px;fill:currentColor;flex:none">
        <path d="${ICON}"></path>
      </svg>
      <span></span>`;
    item.querySelector('span')!.textContent = t(key('menu'));
    item.addEventListener('mouseenter', () => {
      item.style.background =
        'var(--ytmusic-menu-item-hover-background-color, rgba(255,255,255,0.1))';
    });
    item.addEventListener('mouseleave', () => {
      item.style.background = '';
    });
    item.addEventListener('click', () => {
      const videoId = this.menuVideoId;
      document
        .querySelector<HTMLElement & { close?: () => void }>(
          'ytmusic-popup-container tp-yt-iron-dropdown',
        )
        ?.close?.();
      const queueData = this.menuQueueData;
      if (videoId) this.openModal(videoId, queueData).catch(console.warn);
    });
    return item;
  }

  private closeModal() {
    this.modal?.remove();
    this.modal = undefined;
  }

  private async openModal(
    videoId: string,
    queueData: Partial<Record<InsertPosition, unknown>>,
  ) {
    this.closeModal();
    const host = document.createElement('play-from-modal');
    this.modal = host;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${styles}</style>
      <div class="backdrop"></div>
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="cover"><img alt="" /></div>
        <canvas class="waveform"></canvas>
        <div class="time"></div>
        <div class="buttons">
          <button class="cancel"></button>
          <button class="secondary queue-end"></button>
          <button class="secondary queue-next"></button>
          <button class="confirm"></button>
        </div>
      </div>`;
    const $ = <T extends Element>(selector: string) =>
      root.querySelector<T>(selector)!;
    const img = $<HTMLImageElement>('img');
    const canvas = $<HTMLCanvasElement>('canvas');
    const time = $<HTMLElement>('.time');
    const confirm = $<HTMLButtonElement>('.confirm');
    $<HTMLButtonElement>('.cancel').textContent = t(key('cancel'));
    const queueButtons: [HTMLButtonElement, InsertPosition][] = [
      [$<HTMLButtonElement>('.queue-next'), 'INSERT_AFTER_CURRENT_VIDEO'],
      [$<HTMLButtonElement>('.queue-end'), 'INSERT_AT_END'],
    ];
    queueButtons[0][0].textContent = t(key('play-next'));
    queueButtons[1][0].textContent = t(key('add-to-queue'));

    let length = 0;
    let start = 0;
    /** `undefined`: until the song's end. */
    let end: number | undefined;
    const interval = (): Interval => ({ start, end });
    const endOrLength = () => end ?? length;
    let peaks: Float32Array | undefined;
    const update = () => {
      drawWaveform(
        canvas,
        peaks,
        length ? endOrLength() / length : 0,
        length ? start / length : 0,
        true,
      );
      const range = `${formatTime(start)} – ${formatTime(endOrLength())}`;
      time.textContent = `${range} / ${formatTime(length)}`;
      confirm.textContent = t(key('confirm'), { range });
      confirm.disabled = !length;
      for (const [button, position] of queueButtons) {
        button.disabled = !length || !queueData[position];
      }
    };

    const timeAt = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const share = Math.min(
        1,
        Math.max(0, (event.clientX - rect.left) / rect.width),
      );
      return share * length;
    };
    /** Which handle is being dragged: the start or the end. */
    let handle: 'start' | 'end' = 'start';
    const pick = (event: PointerEvent) => {
      if (!length) return;
      const at = timeAt(event);
      if (handle === 'start') {
        start = Math.min(at, endOrLength() - MIN_INTERVAL);
        start = Math.max(0, start);
      } else {
        const value = Math.max(at, start + MIN_INTERVAL);
        // Dragged to the very end: play until the song's end.
        end = value >= length - 0.5 ? undefined : value;
      }
      update();
    };
    let dragging = false;
    canvas.addEventListener('pointerdown', (event) => {
      if (!length) return;
      dragging = true;
      canvas.setPointerCapture(event.pointerId);
      // Move whichever handle is closer to the pointer.
      const at = timeAt(event);
      handle =
        Math.abs(at - start) <= Math.abs(at - endOrLength()) ? 'start' : 'end';
      pick(event);
    });
    canvas.addEventListener('pointermove', (event) => dragging && pick(event));
    canvas.addEventListener('pointerup', () => {
      dragging = false;
    });

    const close = () => this.closeModal();
    const play = () => {
      if (!length) return;
      close();
      this.play(videoId, interval());
    };
    $('.backdrop').addEventListener('click', close);
    $('.cancel').addEventListener('click', close);
    confirm.addEventListener('click', play);
    for (const [button, position] of queueButtons) {
      button.addEventListener('click', () => {
        const data = queueData[position];
        if (!length || !data) return;
        close();
        this.enqueue(videoId, interval(), data);
      });
    }
    // Keep YouTube Music shortcuts from firing while the modal is open.
    host.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') close();
      if (event.key === 'Enter') play();
    });

    document.body.append(host);
    $<HTMLElement>('.dialog').tabIndex = -1;
    $<HTMLElement>('.dialog').focus();
    update();

    // Not played recently: a hidden muted player loads it in the background.
    loadPeaks(videoId)
      .then((loaded) => {
        if (this.modal !== host || !loaded) return;
        peaks = loaded;
        update();
      })
      .catch(() => {});

    const details = await fetchDetails(videoId);
    if (this.modal !== host) return;
    length = details.length;
    if (details.thumbnail) img.src = details.thumbnail;
    img.alt = details.title;
    update();
  }

  /**
   * Add `videoId` to the queue with YouTube Music's own action, and play
   * only `interval` of it when its turn comes.
   */
  private enqueue(videoId: string, interval: Interval, data: unknown) {
    const item = document.createElement(
      'ytmusic-menu-service-item-renderer',
    ) as HTMLElement & { data?: unknown; onTap?: () => void };
    item.hidden = true;
    document.body.append(item);
    item.data = data;
    try {
      item.onTap?.();
    } finally {
      setTimeout(() => item.remove(), 1000);
    }
    if (interval.start >= 1 || interval.end !== undefined) {
      this.scheduled.set(videoId, interval);
    } else {
      this.scheduled.delete(videoId);
    }
  }

  /** Play `interval` of `videoId` now, crossfading from the current song. */
  private play(videoId: string, interval: Interval) {
    const { api } = this;
    const seconds = interval.start;
    // Same song: just jump there.
    if (api.getVideoData()?.video_id === videoId) {
      this.activeEnd =
        interval.end === undefined ? undefined : { videoId, end: interval.end };
      api.seekTo(seconds);
      return;
    }
    this.playNow = { interval, key: videoId, at: performance.now() };
    // Inside the current queue, keep the queue (play it from its position).
    const queueItem = [
      ...document.querySelectorAll<
        HTMLElement & {
          data?: {
            videoId?: string;
            navigationEndpoint?: { watchEndpoint?: WatchEndpoint };
          };
        }
      >('ytmusic-player-queue-item'),
    ].find((item) => item.data?.videoId === videoId);
    const watchEndpoint: WatchEndpoint = {
      ...(queueItem?.data?.navigationEndpoint?.watchEndpoint ?? { videoId }),
      startTimeSeconds: Math.floor(seconds),
    };

    this.prepareCrossfade(seconds);
    document.querySelector('ytmusic-app')?.dispatchEvent(
      new CustomEvent('yt-navigate', {
        bubbles: true,
        composed: true,
        detail: { endpoint: { watchEndpoint } },
      }),
    );
  }

  /**
   * Make the song actually play from `seconds`. YouTube Music sometimes
   * ignores the start time, and while loading it may report the requested
   * time before playing from 0:00, so only trust the position once the song
   * is really playing, and keep checking until it has stayed there.
   */
  private ensurePosition(videoId: string, seconds: number) {
    this.cancelEnsure?.();
    const { api } = this;
    const started = performance.now();
    let settledSince: number | undefined;
    const timer = setInterval(() => {
      const now = performance.now();
      if (now - started > ENSURE_TIMEOUT) {
        this.cancelEnsure?.();
        return;
      }
      const video = document.querySelector('video');
      const playing =
        video &&
        !video.paused &&
        video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
      if (api.getVideoData()?.video_id !== videoId || !playing) return;
      if (!nearStart(api.getCurrentTime(), seconds)) {
        api.seekTo(seconds);
        settledSince = undefined;
      } else {
        settledSince ??= now;
        if (now - settledSince > SETTLE_TIME) this.cancelEnsure?.();
      }
    }, 50);
    this.cancelEnsure = () => {
      clearInterval(timer);
      this.cancelEnsure = undefined;
    };
  }
}

const styles = `
  :host { position: fixed; inset: 0; z-index: 10000; font-family: Roboto, Arial, sans-serif; }
  .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.6); }
  .dialog {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(440px, calc(100vw - 32px)); padding: 20px; box-sizing: border-box;
    background: #212121; border-radius: 12px; color: #fff; outline: none;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  }
  .cover { width: 100%; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: #333; }
  .cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .waveform { display: block; width: 100%; height: 72px; margin-top: 16px; cursor: pointer; touch-action: none; }
  .time { margin-top: 6px; font-size: 13px; color: rgba(255, 255, 255, 0.7); font-variant-numeric: tabular-nums; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  button {
    border: none; border-radius: 18px; padding: 9px 18px; font: inherit; font-size: 14px;
    font-weight: 500; cursor: pointer;
  }
  .cancel { background: transparent; color: #fff; }
  .cancel:hover { background: rgba(255, 255, 255, 0.1); }
  .buttons { flex-wrap: wrap; }
  .cancel { margin-right: auto; }
  .secondary { background: rgba(255, 255, 255, 0.1); color: #fff; }
  .secondary:hover { background: rgba(255, 255, 255, 0.18); }
  .secondary:disabled { opacity: 0.4; cursor: default; }
  .confirm { background: #fff; color: #000; }
  .confirm:disabled { opacity: 0.5; cursor: default; }
`;

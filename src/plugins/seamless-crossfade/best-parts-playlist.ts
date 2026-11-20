/**
 * "Play best parts" / "Shuffle best parts" in a playlist's (or album's)
 * menu: plays its songs (all, or as many as set; in order, or shuffled), each
 * only for its best part (see `best-part.ts`).
 */
import { t } from '@/i18n';
import {
  innertube,
  parseContinuation,
  parseTracks,
  type Track,
} from '@/plugins/utils/renderer/innertube';

import { bestPartStart, loadReplayGraph } from './best-part';
import {
  type Interval,
  placeDropdown,
  type PlayEndpoint,
} from './play-from';

/** Songs whose replay data is fetched at the same time. */
const PARALLEL = 6;
/** How long to wait for one song to show up in the queue. */
const QUEUE_WAIT = 4000;
/** Playlist pages read at most (≈100 songs each). */
const MAX_PAGES = 50;

const key = (name: string) => `plugins.seamless-crossfade.best-parts.${name}`;

// Material "auto awesome" (sparkles) and "shuffle" icons.
const PLAY_ICON =
  'M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z';
const SHUFFLE_ICON =
  'M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z';

type WithData = HTMLElement & { data?: unknown };

/** The playlist an open menu belongs to, if it is a playlist/album menu. */
const menuPlaylist = (listbox: Element) => {
  for (const item of listbox.children) {
    const data = (item as WithData).data as
      | {
          serviceEndpoint?: {
            queueAddEndpoint?: { queueTarget?: { playlistId?: string } };
          };
        }
      | undefined;
    const playlistId =
      data?.serviceEndpoint?.queueAddEndpoint?.queueTarget?.playlistId;
    if (playlistId) return playlistId;
  }
  return undefined;
};

type QueueItem = Record<string, unknown>;
/** The player's queue: its store and the actions its own UI sends. */
type QueueElement = HTMLElement & {
  dispatch?: (action: { type: string; payload?: unknown }) => void;
  queue?: {
    store?: {
      store?: {
        getState(): {
          queue?: {
            items?: QueueItem[];
            nextQueueItemId?: unknown;
            queueContextParams?: string;
          };
        };
      };
    };
  };
};
const queueElement = () => document.querySelector<QueueElement>('#queue');
const queueState = () => queueElement()?.queue?.store?.store?.getState().queue;

const isSelected = (item: QueueItem) => {
  const wrapper = item.playlistPanelVideoWrapperRenderer as
    | { primaryRenderer?: { playlistPanelVideoRenderer?: { selected?: boolean } } }
    | undefined;
  const own = item.playlistPanelVideoRenderer as
    | { selected?: boolean }
    | undefined;
  const video = own ?? wrapper?.primaryRenderer?.playlistPanelVideoRenderer;
  return video?.selected === true;
};

/**
 * Make the queue the playing song followed by `videoIds` only (whatever
 * followed it is dropped), in one go. False if the queue can't be changed
 * this way.
 */
const replaceUpNext = async (videoIds: string[]) => {
  const queue = queueElement();
  const state = queueState();
  if (!queue?.dispatch || !state?.items) return false;
  const json = await innertube('music/get_queue', {
    queueContextParams: state.queueContextParams,
    videoIds,
  });
  const items = (
    (json.queueDatas as { content?: unknown }[] | undefined) ?? []
  )
    .map((data) => data.content)
    .filter(Boolean);
  if (!items.length) return false;
  const all = queueState()?.items ?? [];
  const current = all.findIndex(isSelected);
  if (current < 0) return false;
  for (let i = all.length - 1; i > current; i--) {
    queue.dispatch({ type: 'REMOVE_ITEM', payload: i });
  }
  queue.dispatch({
    type: 'ADD_ITEMS',
    payload: {
      nextQueueItemId: queueState()?.nextQueueItemId,
      index: current + 1,
      items,
      shuffleEnabled: false,
      shouldAssignIds: true,
    },
  });
  return true;
};

/** Fisher–Yates shuffle (in place). */
const shuffled = <T>(items: T[]) => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
};

const queueLength = () =>
  document.querySelectorAll('ytmusic-player-queue-item').length;

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Wait (up to `timeout`) until `done()`; returns whether it happened. */
const waitFor = async (done: () => boolean, timeout: number) => {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    if (done()) return true;
    await wait(100);
  }
  return done();
};

const seconds = (duration: string | undefined) => {
  if (!duration) return undefined;
  let total = 0;
  for (const part of duration.split(':')) {
    const carried = total * 60;
    total = carried + Number(part);
  }
  return Number.isFinite(total) && total > 0 ? total : undefined;
};

/** Every song of a playlist. */
const playlistTracks = async (playlistId: string) => {
  const tracks: Track[] = [];
  let json = await innertube('browse', {
    browseId: `VL${playlistId.replace(/^VL/, '')}`,
  });
  for (let page = 0; page < MAX_PAGES; page++) {
    tracks.push(...parseTracks(json));
    const next = parseContinuation(json);
    if (!next) break;
    json = await innertube('browse', { continuation: next });
  }
  return tracks;
};

/**
 * The part of a song to play: its best part, the middle without replay
 * data, or the whole song if it is short.
 */
const partOf = async (track: Track, part: number): Promise<Interval> => {
  const length = seconds(track.duration);
  if (!length || length <= part + 20) return { start: 0 };
  const graph = await loadReplayGraph(track.videoId);
  const start = graph
    ? bestPartStart(graph, length, part)
    : Math.max(15, Math.round(length * 0.45) - Math.round(part / 2));
  return { start, end: Math.min(length, start + part) };
};

/** Start playing an endpoint, the way YouTube Music's own links do. */
const navigate = (endpoint: PlayEndpoint) => {
  document.querySelector('ytmusic-app')?.dispatchEvent(
    new CustomEvent('yt-navigate', {
      bubbles: true,
      composed: true,
      detail: { endpoint },
    }),
  );
};

const menuStyles = `
  :host { position: fixed; inset: 0; z-index: 10000; font-family: Roboto, Arial, sans-serif; }
  .backdrop { position: absolute; inset: 0; }
  .dialog { position: absolute; min-width: 220px; padding: 8px 0; background: #212121; border-radius: 10px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6); outline: none; }
  button { display: flex; align-items: center; gap: 14px; width: 100%; padding: 10px 16px; background: none; border: none; color: #fff; font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
  button:hover, button:focus-visible { background: rgba(255, 255, 255, 0.1); outline: none; }
  svg { fill: currentColor; flex: none; }
`;

export class BestPartsPlaylist {
  private observer?: MutationObserver;
  private items: HTMLElement[] = [];
  private playlistId?: string;
  private spinner?: HTMLElement;
  /** The open playlist dropdown. */
  private menu?: HTMLElement;
  /** Bumped by every run, so an older run that finishes late does nothing. */
  private run = 0;

  constructor(
    private readonly player: {
      /** Play these parts when their songs come up (replaces older ones). */
      schedule: (
        parts: Map<string, Interval>,
        titles: Map<string, string>,
      ) => void;
      /** Play a part now, crossfading. */
      play: (videoId: string, interval: Interval) => void;
      /** Insert a song right after the playing one. */
      playNext: (videoId: string, interval: Interval) => void;
      /** Length of each song's part, in seconds. */
      partLength: () => number;
      /** Songs per run (`undefined`: the whole playlist). */
      songCount: () => number | undefined;
    },
  ) {}

  install() {
    const container = document.querySelector('ytmusic-popup-container');
    if (!container) return;
    this.items = [
      // YouTube Music no longer has its own in this menu.
      this.createItem(SHUFFLE_ICON, t(key('shuffle-play')), () =>
        this.shufflePlay(),
      ),
      this.createItem(PLAY_ICON, t(key('play')), () => this.startRun(false)),
      this.createItem(SHUFFLE_ICON, t(key('shuffle')), () =>
        this.startRun(true),
      ),
    ];
    this.observer = new MutationObserver(() => this.addToMenu());
    this.observer.observe(container, { childList: true, subtree: true });
  }

  uninstall() {
    this.observer?.disconnect();
    for (const item of this.items) item.remove();
    this.items = [];
    this.run++;
    this.spinner?.remove();
    this.menu?.remove();
  }

  private addToMenu() {
    const listbox = document.querySelector(
      'ytmusic-menu-popup-renderer tp-yt-paper-listbox',
    );
    if (!listbox) return;
    const playlistId = menuPlaylist(listbox);
    if (!playlistId) {
      for (const item of this.items) item.remove();
      return;
    }
    this.playlistId = playlistId;
    const [first, ...others] = this.items;
    const inPlace =
      first.parentElement === listbox &&
      others.every(
        (item, i) => item.previousElementSibling === this.items[i],
      );
    if (inPlace) return;
    listbox.prepend(...this.items);
  }

  private startRun(shuffle: boolean, playlistId = this.playlistId) {
    if (playlistId) this.start(playlistId, shuffle).catch(console.warn);
  }

  /** The whole playlist, shuffled (YouTube Music's own shuffled play). */
  private shufflePlay(playlistId = this.playlistId) {
    if (!playlistId) return;
    navigate({
      watchPlaylistEndpoint: { playlistId, params: 'wAEB8gECKAE%3D' },
    });
  }

  /**
   * What to do with a playlist whose play button was clicked: a dropdown
   * under the button (play, shuffle play, best parts, shuffled best parts).
   */
  openMenu(playlistId: string, endpoint: PlayEndpoint, anchor: HTMLElement) {
    this.menu?.remove();
    const host = document.createElement('best-parts-menu');
    this.menu = host;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${menuStyles}</style>
      <div class="backdrop"></div>
      <div class="dialog" role="menu"></div>`;
    const dialog = root.querySelector<HTMLElement>('.dialog')!;
    const close = () => {
      unplace();
      host.remove();
      if (this.menu === host) this.menu = undefined;
    };
    const actions: [string, string, () => void][] = [
      [PLAY_ICON, t(key('play-all')), () => navigate(endpoint)],
      [SHUFFLE_ICON, t(key('shuffle-play')), () => this.shufflePlay(playlistId)],
      [PLAY_ICON, t(key('play')), () => this.startRun(false, playlistId)],
      [SHUFFLE_ICON, t(key('shuffle')), () => this.startRun(true, playlistId)],
    ];
    for (const [icon, label, action] of actions) {
      const button = document.createElement('button');
      button.setAttribute('role', 'menuitem');
      button.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20"><path d="${icon}"></path></svg><span></span>`;
      button.querySelector('span')!.textContent = label;
      button.addEventListener('click', () => {
        close();
        action();
      });
      dialog.append(button);
    }
    root.querySelector('.backdrop')!.addEventListener('click', close);
    host.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') close();
    });
    document.body.append(host);
    const unplace = placeDropdown(dialog, anchor);
    dialog.tabIndex = -1;
    dialog.focus();
  }

  private createItem(icon: string, label: string, action: () => void) {
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
        <path d="${icon}"></path>
      </svg>
      <span></span>`;
    item.querySelector('span')!.textContent = label;
    item.addEventListener('mouseenter', () => {
      item.style.background =
        'var(--ytmusic-menu-item-hover-background-color, rgba(255,255,255,0.1))';
    });
    item.addEventListener('mouseleave', () => {
      item.style.background = '';
    });
    item.addEventListener('click', () => {
      document
        .querySelector<HTMLElement & { close?: () => void }>(
          'ytmusic-popup-container tp-yt-iron-dropdown',
        )
        ?.close?.();
      action();
    });
    return item;
  }

  private async start(playlistId: string, shuffle: boolean) {
    const run = ++this.run;
    const stale = () => run !== this.run;
    this.showSpinner(t(key('loading')));
    try {
      const all = await playlistTracks(playlistId);
      if (stale()) return;
      // One entry per song, then shuffle (if asked) before capping.
      const unique = [
        ...new Map(all.map((track) => [track.videoId, track])).values(),
      ];
      const tracks = (shuffle ? shuffled(unique) : unique).slice(
        0,
        this.player.songCount() ?? unique.length,
      );
      if (!tracks.length) throw new Error('Empty playlist');

      const parts = new Map<string, Interval>();
      const partLength = this.player.partLength();
      let done = 0;
      const progress = () =>
        this.showSpinner(
          t(key('progress'), {
            done: String(done),
            total: String(tracks.length),
          }),
        );
      progress();
      const pending = [...tracks];
      const worker = async () => {
        for (let track = pending.shift(); track; track = pending.shift()) {
          const part = await partOf(track, partLength).catch(() => ({
            start: 0,
          }));
          parts.set(track.videoId, part);
          done++;
          if (!stale()) progress();
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      if (stale()) return;

      this.player.schedule(
        parts,
        new Map(tracks.map((track) => [track.videoId, track.title])),
      );
      const [first, ...rest] = tracks;
      this.player.play(first.videoId, parts.get(first.videoId)!);
      // Queue the rest right after it, once it plays (last first, each
      // after the previous one landed, so they keep their order).
      const player = document.querySelector<
        HTMLElement & { getVideoData?: () => { video_id?: string } }
      >('#movie_player');
      const playing = () =>
        player?.getVideoData?.()?.video_id === first.videoId;
      await waitFor(playing, 15_000);
      await wait(1000);
      if (stale() || !rest.length) return;
      // All at once, in place of what followed (one at a time, a part
      // could end mid-way and other songs would play in between).
      this.showSpinner(
        t(key('queueing'), { done: '0', total: String(rest.length) }),
      );
      const replaced = await replaceUpNext(
        rest.map((track) => track.videoId),
      ).catch(() => false);
      if (replaced || stale()) return;
      let queued = 0;
      for (const track of [...rest].reverse()) {
        if (stale()) return;
        this.showSpinner(
          t(key('queueing'), {
            done: String(queued),
            total: String(rest.length),
          }),
        );
        const before = queueLength();
        this.player.playNext(track.videoId, parts.get(track.videoId)!);
        await waitFor(() => queueLength() > before, QUEUE_WAIT);
        queued++;
      }
    } finally {
      if (run === this.run) this.hideSpinner();
    }
  }

  private showSpinner(text: string) {
    if (!this.spinner) {
      const host = document.createElement('best-parts-spinner');
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          .toast {
            position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%);
            z-index: 10000; display: flex; align-items: center; gap: 12px;
            padding: 12px 18px; border-radius: 24px; background: #212121;
            color: #fff; font: 14px Roboto, sans-serif;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
          }
          .spinner {
            width: 18px; height: 18px; border-radius: 50%; flex: none;
            border: 2px solid rgba(255, 255, 255, 0.25); border-top-color: #ff0033;
            animation: spin 0.8s linear infinite;
          }
          @keyframes spin { to { transform: rotate(360deg); } }
        </style>
        <div class="toast" role="status"><div class="spinner"></div><span></span></div>`;
      document.body.append(host);
      this.spinner = host;
    }
    this.spinner.shadowRoot!.querySelector('span')!.textContent = text;
  }

  private hideSpinner() {
    this.spinner?.remove();
    this.spinner = undefined;
  }
}

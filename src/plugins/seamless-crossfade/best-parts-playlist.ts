/**
 * "Play best parts" / "Shuffle best parts" in a playlist's (or album's)
 * menu: plays the playlist with YouTube Music's own play/shuffle, but each
 * song only plays its best part (see `best-part.ts`).
 */
import { t } from '@/i18n';
import {
  innertube,
  parseContinuation,
  parseTracks,
  type Track,
} from '@/plugins/utils/renderer/innertube';

import { bestPartStart, loadReplayGraph } from './best-part';

import type { Interval } from './play-from';

/** Length of each song's part, in seconds. */
export const PART_LENGTH = 120;
/** Songs whose replay data is fetched at the same time. */
const PARALLEL = 6;
/** Playlist pages read at most (≈100 songs each). */
const MAX_PAGES = 50;
/** YouTube Music's own "Shuffle play" parameters, if the menu has none. */
const SHUFFLE_PARAMS = 'wAEB8gECKAE%3D';

const key = (name: string) => `plugins.seamless-crossfade.best-parts.${name}`;

// Material "auto awesome" (sparkles) and "shuffle" icons.
const PLAY_ICON =
  'M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z';
const SHUFFLE_ICON =
  'M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z';

type WithData = HTMLElement & { data?: unknown };

interface PlaylistMenu {
  playlistId: string;
  shuffleParams: string;
}

/** The playlist an open menu belongs to, if it is a playlist/album menu. */
const menuPlaylist = (listbox: Element): PlaylistMenu | undefined => {
  let playlistId: string | undefined;
  let shuffleParams: string | undefined;
  for (const item of listbox.children) {
    const data = (item as WithData).data as
      | {
          serviceEndpoint?: {
            queueAddEndpoint?: { queueTarget?: { playlistId?: string } };
          };
          navigationEndpoint?: {
            watchPlaylistEndpoint?: { playlistId?: string; params?: string };
          };
        }
      | undefined;
    playlistId ??=
      data?.serviceEndpoint?.queueAddEndpoint?.queueTarget?.playlistId;
    const watch = data?.navigationEndpoint?.watchPlaylistEndpoint;
    // "Shuffle play" plays the playlist itself; "Start radio" is an RD… mix.
    if (watch?.playlistId && !watch.playlistId.startsWith('RD')) {
      shuffleParams ??= watch.params;
    }
  }
  return playlistId
    ? { playlistId, shuffleParams: shuffleParams ?? SHUFFLE_PARAMS }
    : undefined;
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

/** The part of a song to play: its best part, or the middle without data. */
const partOf = async (track: Track): Promise<Interval | undefined> => {
  const length = seconds(track.duration);
  if (!length || length <= PART_LENGTH + 20) return undefined;
  const graph = await loadReplayGraph(track.videoId);
  const start = graph
    ? bestPartStart(graph, length, PART_LENGTH)
    : Math.max(15, Math.round(length * 0.45) - Math.round(PART_LENGTH / 2));
  return { start, end: Math.min(length, start + PART_LENGTH) };
};

export class BestPartsPlaylist {
  private observer?: MutationObserver;
  private items: HTMLElement[] = [];
  private menu?: PlaylistMenu;
  private spinner?: HTMLElement;
  /** Bumped by every run, so an older run that finishes late does nothing. */
  private run = 0;

  constructor(
    /** Play these parts when their songs come up (replaces older ones). */
    private readonly schedule: (parts: Map<string, Interval>) => void,
  ) {}

  install() {
    const container = document.querySelector('ytmusic-popup-container');
    if (!container) return;
    this.items = [
      this.createItem(PLAY_ICON, t(key('play')), false),
      this.createItem(SHUFFLE_ICON, t(key('shuffle')), true),
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
  }

  private addToMenu() {
    const listbox = document.querySelector(
      'ytmusic-menu-popup-renderer tp-yt-paper-listbox',
    );
    if (!listbox) return;
    const menu = menuPlaylist(listbox);
    if (!menu) {
      for (const item of this.items) item.remove();
      return;
    }
    this.menu = menu;
    const [play, shuffle] = this.items;
    if (play.parentElement === listbox && play.nextElementSibling === shuffle) {
      return;
    }
    listbox.prepend(play, shuffle);
  }

  private createItem(icon: string, label: string, shuffle: boolean) {
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
      const menu = this.menu;
      document
        .querySelector<HTMLElement & { close?: () => void }>(
          'ytmusic-popup-container tp-yt-iron-dropdown',
        )
        ?.close?.();
      if (menu) this.start(menu, shuffle).catch(console.warn);
    });
    return item;
  }

  private async start(menu: PlaylistMenu, shuffle: boolean) {
    const run = ++this.run;
    this.showSpinner(t(key('loading')));
    try {
      const tracks = await playlistTracks(menu.playlistId);
      if (run !== this.run) return;
      if (!tracks.length) throw new Error('Empty playlist');

      const parts = new Map<string, Interval>();
      let done = 0;
      const progress = () =>
        this.showSpinner(
          t(key('progress'), {
            done: String(done),
            total: String(tracks.length),
          }),
        );
      progress();
      const queue = [...tracks];
      const worker = async () => {
        for (let track = queue.shift(); track; track = queue.shift()) {
          const part = await partOf(track).catch(() => undefined);
          if (part) parts.set(track.videoId, part);
          done++;
          if (run === this.run) progress();
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      if (run !== this.run) return;

      this.schedule(parts);
      const endpoint = shuffle
        ? {
            watchPlaylistEndpoint: {
              playlistId: menu.playlistId,
              params: menu.shuffleParams,
            },
          }
        : { watchEndpoint: { playlistId: menu.playlistId } };
      document.querySelector('ytmusic-app')?.dispatchEvent(
        new CustomEvent('yt-navigate', {
          bubbles: true,
          composed: true,
          detail: { endpoint },
        }),
      );
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

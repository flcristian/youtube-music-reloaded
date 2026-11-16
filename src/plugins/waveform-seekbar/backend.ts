/**
 * Waveforms for songs that aren't playing: a hidden, muted YouTube Music
 * window plays the song for a moment, and we take the audio stream URL its
 * player requested (the renderer then downloads and analyses the file).
 */
import { BrowserWindow } from 'electron';

import { createBackend } from '@/utils';

import { SOURCE_CHANNEL } from './channel';

/** Close the hidden window after this long without requests, in ms. */
const IDLE_CLOSE = 3 * 60_000;

/**
 * Runs in the hidden window: play `videoId` and return the URL of its
 * audio stream (matched by duration), then pause.
 */
const findAudioUrl = (videoId: string) => `(async (id) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = () => document.querySelector('#movie_player');
  for (let i = 0; i < 300 && !api()?.getVideoData; i++) await wait(100);
  const player = api();
  if (!player?.getVideoData) return null;
  performance.clearResourceTimings();
  if (player.getVideoData().video_id !== id) {
    document.querySelector('ytmusic-app').dispatchEvent(new CustomEvent('yt-navigate', {
      bubbles: true, composed: true,
      detail: { endpoint: { watchEndpoint: { videoId: id } } },
    }));
  }
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    await wait(200);
    if (player.getVideoData().video_id !== id) continue;
    const length = Number(player.getPlayerResponse()?.videoDetails?.lengthSeconds);
    if (!(length > 0)) continue;
    const hit = performance.getEntriesByType('resource').reverse().find((e) => {
      if (!e.name.includes('videoplayback') || !e.name.includes('mime=audio')) return false;
      const dur = Number(new URL(e.name).searchParams.get('dur'));
      return Math.abs(dur - length) <= 1;
    });
    if (hit) { player.pauseVideo(); return hit.name; }
    if (document.querySelector('video')?.paused) player.playVideo();
  }
  player.pauseVideo?.();
  return null;
})(${JSON.stringify(videoId)})`;

let hidden: BrowserWindow | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
/** Requests run one after another in the single hidden window. */
let queue: Promise<unknown> = Promise.resolve();

const closeHidden = () => {
  hidden?.destroy();
  hidden = undefined;
};

const getHidden = async (main: BrowserWindow, videoId: string) => {
  if (hidden && !hidden.isDestroyed()) return hidden;
  hidden = new BrowserWindow({
    show: false,
    webPreferences: {
      session: main.webContents.session,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  hidden.webContents.setAudioMuted(true);
  await hidden.loadURL(`https://music.youtube.com/watch?v=${videoId}`);
  return hidden;
};

const resolveSource = (main: BrowserWindow, videoId: string) => {
  const job = queue.then(async () => {
    if (idleTimer) clearTimeout(idleTimer);
    try {
      const window = await getHidden(main, videoId);
      return (await window.webContents.executeJavaScript(
        findAudioUrl(videoId),
      )) as string | null;
    } catch (err) {
      console.warn('[waveform-seekbar]', err);
      closeHidden();
      return null;
    } finally {
      idleTimer = setTimeout(closeHidden, IDLE_CLOSE);
    }
  });
  queue = job.catch(() => {});
  return job;
};

export const backend = createBackend({
  start({ ipc, window }) {
    ipc.handle(SOURCE_CHANNEL, (videoId: string) =>
      resolveSource(window, videoId),
    );
  },
  stop({ ipc }) {
    ipc.removeHandler(SOURCE_CHANNEL);
    if (idleTimer) clearTimeout(idleTimer);
    closeHidden();
  },
});

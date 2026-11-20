import { t } from '@/i18n';
import { watchVideo } from '@/plugins/utils/renderer/video-watcher';
import { createPlugin } from '@/utils';

import { backend } from './backend';
import { SOURCE_CHANNEL } from './channel';
import {
  AudioSources,
  computePeaks,
  peaksCache,
  rememberPeaks,
  setUrlResolver,
} from './peaks';
import { Waveform } from './waveform';

import type { MusicPlayer } from '@/types/music-player';

type WaveformSeekbarConfig = {
  enabled: boolean;
  /** Waveform shown instead of the progress bar (toggled with Cmd+Shift+V). */
  visible: boolean;
};

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA');

export default createPlugin<
  unknown,
  unknown,
  {
    config: WaveformSeekbarConfig;
    setConfig?: (config: Partial<WaveformSeekbarConfig>) => unknown;
    sources: AudioSources;
    loading: Set<string>;
    api?: MusicPlayer;
    waveform?: Waveform;
    songId?: string;
    onKeyDown?: (event: KeyboardEvent) => void;
    onTimeUpdate?: () => void;
    video?: HTMLVideoElement;
    unwatchVideo?: () => void;
    apply: () => void;
    load: () => void;
  },
  WaveformSeekbarConfig
>({
  name: () => t('plugins.waveform-seekbar.name'),
  description: () => t('plugins.waveform-seekbar.description'),
  restartNeeded: false,
  config: { enabled: true, visible: true },
  backend,

  renderer: {
    config: { enabled: true, visible: true },
    sources: new AudioSources(),
    loading: new Set(),

    async start({ getConfig, setConfig, ipc }) {
      this.sources.start();
      setUrlResolver(
        (videoId) =>
          ipc.invoke(SOURCE_CHANNEL, videoId) as Promise<string | null>,
      );
      this.setConfig = setConfig;
      this.config = await getConfig();

      this.onKeyDown = (event) => {
        const shortcut =
          (event.metaKey || event.ctrlKey) &&
          event.shiftKey &&
          !event.altKey &&
          event.code === 'KeyV';
        if (!shortcut || isTyping(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        this.config = { ...this.config, visible: !this.config.visible };
        Promise.resolve(
          this.setConfig?.({ visible: this.config.visible }),
        ).catch(() => {});
        this.apply();
      };
      window.addEventListener('keydown', this.onKeyDown, true);
    },

    onPlayerApiReady(api) {
      this.api = api;
      this.waveform = new Waveform(api);
      const onTimeUpdate = () => this.load();
      this.onTimeUpdate = onTimeUpdate;
      // Follow the <video> element when YouTube Music replaces it.
      this.unwatchVideo = watchVideo((video) => {
        this.video?.removeEventListener('timeupdate', onTimeUpdate);
        video.addEventListener('timeupdate', onTimeUpdate);
        this.video = video;
      });
      this.apply();
      this.load();
    },

    onConfigChange(newConfig) {
      this.config = { ...this.config, ...newConfig };
      this.apply();
    },

    /** Show the waveform or the original progress bar. */
    apply() {
      const bar = document.querySelector<HTMLElement>('ytmusic-player-bar');
      const progress = bar?.querySelector<HTMLElement>('#progress-bar');
      if (!bar || !this.waveform) return;
      if (this.config.visible) {
        if (progress) progress.style.visibility = 'hidden';
        this.waveform.show(bar);
      } else {
        if (progress) progress.style.visibility = '';
        this.waveform.hide();
      }
    },

    /** Compute the current song's waveform once (cached per song). */
    load() {
      const { api, waveform } = this;
      if (!api || !waveform) return;
      const songId = api.getVideoData()?.video_id;
      if (!songId) return;

      if (songId !== this.songId) {
        this.songId = songId;
        waveform.setPeaks(peaksCache.get(songId));
      }
      if (peaksCache.has(songId) || this.loading.has(songId)) return;

      const length = Number(
        api.getPlayerResponse()?.videoDetails?.lengthSeconds,
      );
      const source = length > 0 ? this.sources.find(length) : undefined;
      // The stream isn't known yet; try again on the next timeupdate.
      if (!source) return;

      this.loading.add(songId);
      computePeaks(source, songId)
        .then((peaks) => {
          rememberPeaks(songId, peaks);
          if (this.songId === songId) waveform.setPeaks(peaks);
        })
        .catch((err) => console.warn('[waveform-seekbar]', err))
        .finally(() => this.loading.delete(songId));
    },

    stop() {
      this.sources.stop();
      setUrlResolver(undefined);
      if (this.onKeyDown) {
        window.removeEventListener('keydown', this.onKeyDown, true);
      }
      this.unwatchVideo?.();
      if (this.onTimeUpdate) {
        this.video?.removeEventListener('timeupdate', this.onTimeUpdate);
      }
      this.video = undefined;
      this.config = { ...this.config, visible: false };
      this.apply();
    },
  },
});

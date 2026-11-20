import { t } from '@/i18n';
import {
  createToggle,
  registerSettingsSection,
} from '@/plugins/utils/renderer/custom-settings';
import { watchVideo } from '@/plugins/utils/renderer/video-watcher';
import { createPlugin } from '@/utils';

import { backend } from './backend';
import { SOURCE_CHANNEL } from './channel';
import { loadSung } from './lyrics';
import {
  AudioSources,
  computePeaks,
  peaksCache,
  rememberPeaks,
  setUrlResolver,
} from './peaks';
import { guessSung } from './vocals';
import { Waveform } from './waveform';

import type { MusicPlayer } from '@/types/music-player';

type WaveformSeekbarConfig = {
  enabled: boolean;
  /** Waveform shown instead of the progress bar (toggled with Cmd+Shift+V). */
  visible: boolean;
  /** Sung parts coloured on it (lyrics). */
  lyrics: boolean;
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
    /** Whether the playing song has timed lyrics (else: guessed). */
    timedLyrics?: boolean;
    onKeyDown?: (event: KeyboardEvent) => void;
    onTimeUpdate?: () => void;
    video?: HTMLVideoElement;
    unwatchVideo?: () => void;
    unregisterSettings?: () => void;
    apply: () => void;
    load: () => void;
  },
  WaveformSeekbarConfig
>({
  name: () => t('plugins.waveform-seekbar.name'),
  description: () => t('plugins.waveform-seekbar.description'),
  restartNeeded: false,
  config: { enabled: true, visible: true, lyrics: true },
  backend,

  renderer: {
    config: { enabled: true, visible: true, lyrics: true },
    sources: new AudioSources(),
    loading: new Set(),

    async start({ getConfig, setConfig, ipc }) {
      this.sources.start();
      setUrlResolver(
        (videoId) =>
          ipc.invoke(SOURCE_CHANNEL, videoId) as Promise<string | null>,
      );
      this.setConfig = setConfig;
      this.config = { ...this.config, ...(await getConfig()) };

      // In the shared settings modal (Cmd+Shift+.).
      this.unregisterSettings = registerSettingsSection({
        id: 'waveform-seekbar',
        title: () => t('plugins.waveform-seekbar.name'),
        render: (container) => {
          const { row } = createToggle({
            label: t('plugins.waveform-seekbar.settings.lyrics'),
            checked: this.config.lyrics,
            onChange: (lyrics) => {
              this.config = { ...this.config, lyrics };
              Promise.resolve(this.setConfig?.({ lyrics })).catch(() => {});
              this.apply();
            },
          });
          container.append(row);
        },
      });

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
      this.waveform.setSungVisible(this.config.lyrics);
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
        waveform.setSung([]);
        this.timedLyrics = undefined;
        const data = api.getVideoData();
        // Timed lyrics, else a guess from its audio (once analysed).
        loadSung(songId, data?.title, data?.author).then((sung) => {
          if (this.songId !== songId) return;
          this.timedLyrics = sung.length > 0;
          waveform.setSung(sung.length ? sung : guessSung(songId));
        });
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
          if (this.songId !== songId) return;
          waveform.setPeaks(peaks);
          if (!this.timedLyrics) waveform.setSung(guessSung(songId));
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
      this.unregisterSettings?.();
      this.config = { ...this.config, visible: false };
      this.apply();
    },
  },
});

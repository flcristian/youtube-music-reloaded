import { t } from '@/i18n';
import { registerSettingsSection } from '@/plugins/utils/renderer/custom-settings';
import { registerDjFeatures } from '@/plugins/utils/renderer/dj-registry';
import { watchVideo } from '@/plugins/utils/renderer/video-watcher';
import { createPlugin } from '@/utils';

import { BestPartsPlaylist } from './best-parts-playlist';
import { Crossfader } from './crossfader';
import { Leveler } from './leveler';
import { MirrorManager } from './mirror';
import { PlayFrom } from './play-from';
import { defaultConfig, type SeamlessCrossfadeConfig } from './settings';
import { renderSettings } from './settings-section';

import type { MusicPlayer } from '@/types/music-player';

export type { SeamlessCrossfadeConfig } from './settings';

export default createPlugin<
  unknown,
  unknown,
  {
    config: SeamlessCrossfadeConfig;
    mirrors?: MirrorManager;
    api?: MusicPlayer;
    crossfader?: Crossfader;
    playFrom?: PlayFrom;
    bestParts?: BestPartsPlaylist;
    unregisterSettings?: () => void;
    saveConfig?: (changes: Partial<SeamlessCrossfadeConfig>) => void;
    unwatchVideo?: () => void;
    leveler?: Leveler;
  },
  SeamlessCrossfadeConfig
>({
  name: () => t('plugins.seamless-crossfade.name'),
  description: () => t('plugins.seamless-crossfade.description'),
  // MediaSource hooks are installed once and can't be cleanly removed.
  restartNeeded: true,
  config: defaultConfig,

  renderer: {
    config: defaultConfig,

    async start({ getConfig, setConfig }) {
      // Hook MediaSource first, before yielding, to catch it as early as possible.
      this.mirrors = new MirrorManager(
        () => document.querySelector('video')?.currentTime ?? 0,
      );
      this.mirrors.install();
      this.config = { ...defaultConfig, ...(await getConfig()) };

      // Settings live in the shared custom-settings modal (Cmd+Shift+.).
      this.unregisterSettings = registerSettingsSection({
        id: 'seamless-crossfade',
        title: () => t('plugins.seamless-crossfade.name'),
        render: (container) =>
          renderSettings(container, this.config, (changes) =>
            this.saveConfig?.(changes),
          ),
      });
      this.saveConfig = (changes) => {
        this.config = { ...this.config, ...changes };
        Promise.resolve(setConfig(changes)).catch(() => {});
      };
    },

    onConfigChange(newConfig) {
      this.config = { ...defaultConfig, ...newConfig };
    },

    onPlayerApiReady(api) {
      this.api = api;
      const video = document.querySelector<HTMLVideoElement>('video');
      if (!video || !this.mirrors) return;

      this.crossfader = new Crossfader(
        api,
        video,
        this.mirrors,
        () => this.config,
      );
      this.crossfader.attach();

      // "Play from…" in song menus.
      this.playFrom = new PlayFrom(
        api,
        (startAt, override, videoId) =>
          this.crossfader?.prepareJump(
            this.config.jumpDuration,
            startAt,
            override,
            videoId,
          ),
        () => this.config.askOnPlay,
        () => this.config.bestPartLength,
      );
      this.playFrom.install();
      const parts = this.playFrom;
      this.bestParts = new BestPartsPlaylist({
        schedule: (entries, titles) => parts.startBestParts(entries, titles),
        play: (videoId, interval) => parts.play(videoId, interval),
        playNext: (videoId, interval) =>
          parts.enqueueSong(videoId, interval, 'INSERT_AFTER_CURRENT_VIDEO'),
        partLength: () => this.config.bestPartLength,
        songCount: () =>
          this.config.bestPartsAll ? undefined : this.config.bestPartsSongs,
      });
      this.bestParts.install();
      const bestParts = this.bestParts;
      parts.onPlaylistPlay = (playlistId, endpoint, anchor) =>
        bestParts.openMenu(playlistId, endpoint, anchor);
      this.crossfader.scheduledStart = (videoId) =>
        this.playFrom?.scheduledStart(videoId);
      this.crossfader.partStart = (videoId) => {
        const part = this.playFrom?.currentPart();
        return part && this.api?.getVideoData()?.video_id === videoId
          ? part.start
          : undefined;
      };
      this.crossfader.intervalEnd = (videoId) =>
        this.playFrom?.intervalEnd(videoId);
      this.leveler = new Leveler(
        api,
        () => this.config.loudnessMatching,
        () => this.playFrom?.currentPart(),
      );
      const leveler = this.leveler;
      this.crossfader.handOff = (audio) => leveler.handOff(audio);
      this.crossfader.shape = (element, shape) => leveler.shape(element, shape);
      this.crossfader.loopOut = (element, after, length) =>
        leveler.loop(element, after, length);
      this.crossfader.holdLoop = (element, held) => leveler.hold(element, held);
      this.mirrors.onDispose = (audio) => leveler.release(audio);
      this.crossfader.transitionFor = (videoId, consume) =>
        parts.transitionFor(videoId, consume);
      this.crossfader.startNextAt = (videoId, start) =>
        parts.startNextAt(videoId, start);
      this.mirrors.onMirror = (audio) => leveler.prepare(audio);
      const playingMirror = this.mirrors.current;
      if (playingMirror) leveler.prepare(playingMirror.audio);

      // For the MCP bridge (and other plugins).
      const playFrom = this.playFrom;
      registerDjFeatures({
        play: (videoId, interval) => playFrom.play(videoId, interval),
        enqueue: (videoId, interval, position) =>
          playFrom.enqueueSong(
            videoId,
            interval,
            position === 'next'
              ? 'INSERT_AFTER_CURRENT_VIDEO'
              : 'INSERT_AT_END',
          ),
        currentPart: () => playFrom.currentPart(),
        setPartEnd: (end) => playFrom.setPartEnd(end),
        getCrossfadeConfig: () => this.config,
        setCrossfadeConfig: (changes) => this.saveConfig?.(changes),
      });

      this.unwatchVideo = watchVideo((current) => {
        this.crossfader?.setVideo(current);
        this.playFrom?.setVideo(current);
        this.leveler?.setVideo(current);
      });
    },

    stop() {
      this.unwatchVideo?.();
      this.leveler?.stop();
      registerDjFeatures(undefined);
      this.unregisterSettings?.();
      this.crossfader?.detach();
      this.playFrom?.uninstall();
      this.bestParts?.uninstall();
    },
  },
});

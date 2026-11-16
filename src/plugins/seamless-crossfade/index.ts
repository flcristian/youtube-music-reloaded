import { t } from '@/i18n';
import { registerSettingsSection } from '@/plugins/utils/renderer/custom-settings';
import { createPlugin } from '@/utils';

import { Crossfader } from './crossfader';
import { MirrorManager } from './mirror';
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
    unregisterSettings?: () => void;
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
          renderSettings(container, this.config, (changes) => {
            this.config = { ...this.config, ...changes };
            Promise.resolve(setConfig(changes)).catch(() => {});
          }),
      });
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
    },

    stop() {
      this.unregisterSettings?.();
      this.crossfader?.detach();
    },
  },
});

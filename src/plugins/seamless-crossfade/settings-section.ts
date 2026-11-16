import { t } from '@/i18n';
import {
  createChoice,
  createSlider,
  createToggle,
} from '@/plugins/utils/renderer/custom-settings';

import {
  clampDuration,
  type FadeCurve,
  MAX_DURATION,
  MIN_DURATION,
  type SeamlessCrossfadeConfig,
} from './settings';

const key = (name: string) => `plugins.seamless-crossfade.settings.${name}`;

/** Builds the Seamless Crossfade section of the custom settings modal. */
export const renderSettings = (
  container: HTMLElement,
  config: SeamlessCrossfadeConfig,
  save: (changes: Partial<SeamlessCrossfadeConfig>) => void,
) => {
  const durationRow = (
    value: number,
    enabled: boolean,
    onChange: (seconds: number) => void,
  ) => {
    const slider = createSlider({
      label: t(key('duration')),
      value,
      min: MIN_DURATION,
      max: MAX_DURATION,
      step: 0.5,
      unit: 's',
      onChange: (seconds) => onChange(clampDuration(seconds)),
    });
    slider.setDisabled(!enabled);
    return slider;
  };

  const autoDuration = durationRow(
    config.autoDuration,
    config.autoEnabled,
    (autoDuration) => save({ autoDuration }),
  );
  const autoToggle = createToggle({
    label: t(key('auto')),
    checked: config.autoEnabled,
    onChange: (autoEnabled) => {
      autoDuration.setDisabled(!autoEnabled);
      save({ autoEnabled });
    },
  });

  const manualDuration = durationRow(
    config.manualDuration,
    config.manualEnabled,
    (manualDuration) => save({ manualDuration }),
  );
  const manualToggle = createToggle({
    label: t(key('manual')),
    checked: config.manualEnabled,
    onChange: (manualEnabled) => {
      manualDuration.setDisabled(!manualEnabled);
      save({ manualEnabled });
    },
  });

  const curve = createChoice<FadeCurve>({
    label: t(key('curve.label')),
    value: config.curve,
    choices: [
      { value: 'equal-power', label: t(key('curve.equal-power')) },
      { value: 'linear', label: t(key('curve.linear')) },
      { value: 'steep', label: t(key('curve.steep')) },
    ],
    onChange: (value) => save({ curve: value }),
  });

  container.append(
    autoToggle.row,
    autoDuration.row,
    manualToggle.row,
    manualDuration.row,
    curve.row,
  );
};

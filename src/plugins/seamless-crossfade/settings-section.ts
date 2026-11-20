import { t } from '@/i18n';
import {
  createChoice,
  createSlider,
  createToggle,
} from '@/plugins/utils/renderer/custom-settings';

import {
  clampDuration,
  type FadeCurve,
  type TransitionStyle,
  MAX_BEATS,
  MAX_DURATION,
  MAX_PART_LENGTH,
  MAX_SONGS,
  MAX_STEEPNESS,
  MIN_BEATS,
  MIN_DURATION,
  MIN_PART_LENGTH,
  MIN_SONGS,
  MIN_STEEPNESS,
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

  const jumpDuration = createSlider({
    label: t(key('jump')),
    value: config.jumpDuration,
    min: MIN_DURATION,
    max: MAX_DURATION,
    step: 0.5,
    unit: 's',
    onChange: (seconds) => save({ jumpDuration: clampDuration(seconds) }),
  });

  const fadeBeats = createSlider({
    label: t(key('fade-beats')),
    value: config.fadeBeats,
    min: MIN_BEATS,
    max: MAX_BEATS,
    step: 4,
    onChange: (beats) => save({ fadeBeats: beats }),
  });
  fadeBeats.setDisabled(!config.fadeInBeats);
  const transitionView = createToggle({
    label: t(key('transition-view')),
    checked: config.transitionView,
    onChange: (value) => save({ transitionView: value }),
  });
  const dropSync = createToggle({
    label: t(key('drop-sync')),
    checked: config.dropSync,
    onChange: (value) => save({ dropSync: value }),
  });
  const fadeInBeats = createToggle({
    label: t(key('fade-in-beats')),
    checked: config.fadeInBeats,
    onChange: (value) => {
      fadeBeats.setDisabled(!value);
      save({ fadeInBeats: value });
    },
  });

  const askOnPlay = createToggle({
    label: t(key('ask-on-play')),
    checked: config.askOnPlay,
    onChange: (value) => save({ askOnPlay: value }),
  });

  const bestPartLength = createSlider({
    label: t(key('best-part-length')),
    value: config.bestPartLength,
    min: MIN_PART_LENGTH,
    max: MAX_PART_LENGTH,
    step: 10,
    unit: 's',
    onChange: (seconds) => save({ bestPartLength: seconds }),
  });

  const bestPartsSongs = createSlider({
    label: t(key('best-parts-songs')),
    value: config.bestPartsSongs,
    min: MIN_SONGS,
    max: MAX_SONGS,
    step: 10,
    onChange: (songs) => save({ bestPartsSongs: songs }),
  });
  bestPartsSongs.setDisabled(config.bestPartsAll);
  const bestPartsAll = createToggle({
    label: t(key('best-parts-all')),
    checked: config.bestPartsAll,
    onChange: (all) => {
      bestPartsSongs.setDisabled(all);
      save({ bestPartsAll: all });
    },
  });

  const steepness = createSlider({
    label: t(key('outro-steepness')),
    value: config.outroSteepness,
    min: MIN_STEEPNESS,
    max: MAX_STEEPNESS,
    step: 0.5,
    unit: '',
    onChange: (value) => save({ outroSteepness: value }),
  });
  steepness.setDisabled(config.curve !== 'exponential-out');

  const curve = createChoice<FadeCurve>({
    label: t(key('curve.label')),
    value: config.curve,
    choices: [
      { value: 'equal-power', label: t(key('curve.equal-power')) },
      { value: 'linear', label: t(key('curve.linear')) },
      { value: 'steep', label: t(key('curve.steep')) },
      { value: 'exponential-out', label: t(key('curve.exponential-out')) },
    ],
    onChange: (value) => {
      steepness.setDisabled(value !== 'exponential-out');
      save({ curve: value });
    },
  });

  const style = createChoice<TransitionStyle>({
    label: t(key('style.label')),
    value: config.transitionStyle,
    choices: [
      { value: 'fade', label: t(key('style.fade')) },
      { value: 'tape-stop', label: t(key('style.tape-stop')) },
      { value: 'filter', label: t(key('style.filter')) },
      { value: 'bass-swap', label: t(key('style.bass-swap')) },
      { value: 'echo-out', label: t(key('style.echo-out')) },
      { value: 'loop-out', label: t(key('style.loop-out')) },
      { value: 'filter-stop', label: t(key('style.filter-stop')) },
      { value: 'stop-filter', label: t(key('style.stop-filter')) },
    ],
    onChange: (value) => save({ transitionStyle: value }),
  });

  const loudnessMatching = createToggle({
    label: t(key('loudness-matching')),
    checked: config.loudnessMatching,
    onChange: (value) => save({ loudnessMatching: value }),
  });

  container.append(
    autoToggle.row,
    autoDuration.row,
    manualToggle.row,
    manualDuration.row,
    jumpDuration.row,
    fadeInBeats.row,
    fadeBeats.row,
    dropSync.row,
    transitionView.row,
    askOnPlay.row,
    bestPartLength.row,
    bestPartsAll.row,
    bestPartsSongs.row,
    style.row,
    curve.row,
    steepness.row,
    loudnessMatching.row,
  );
};

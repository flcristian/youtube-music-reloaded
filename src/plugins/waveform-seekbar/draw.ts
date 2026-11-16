import { PEAK_COUNT } from './peaks';

const BAR_WIDTH = 2;
const BAR_GAP = 1;
/** Share of the height used by the bars; the rest is their reflection. */
const TOP_SHARE = 0.7;
/** Bar height while there is no waveform (still shows progress). */
const FLAT = 0.04;

const PLAYED = '#ff0033';
const PLAYED_REFLECTION = 'rgba(255, 0, 51, 0.45)';
/** The part that is still going to play. */
const UPCOMING = 'rgba(255, 0, 51, 0.5)';
const UPCOMING_REFLECTION = 'rgba(255, 0, 51, 0.22)';
const UNPLAYED = 'rgba(255, 255, 255, 0.45)';
const UNPLAYED_REFLECTION = 'rgba(255, 255, 255, 0.2)';

/** Number of bars that fit in `width` CSS pixels. */
export const barCount = (width: number) =>
  Math.floor(width / (BAR_WIDTH + BAR_GAP));

/**
 * Draws a SoundCloud-style waveform on `canvas` at its CSS size, with the
 * part between `highlightFrom` and `highlight` (shares, 0–1) in the accent
 * colour. With `markers`, also draws thin lines at both ends of that part
 * (`'end'`: only at its end). With `progress` (share), the part after it is
 * a lighter accent: still to play. Without `peaks`, draws flat bars.
 */
export const drawWaveform = (
  canvas: HTMLCanvasElement,
  peaks: Float32Array | undefined,
  highlight: number,
  highlightFrom = 0,
  markers: boolean | 'end' = false,
  progress?: number,
) => {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;

  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d')!;
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);

  const bars = barCount(width);
  const highlighted = Math.round(highlight * bars);
  const highlightedFrom = Math.round(highlightFrom * bars);
  const played =
    progress === undefined ? highlighted : Math.round(progress * bars);
  const baseline = height * TOP_SHARE;
  for (let i = 0; i < bars; i++) {
    let level = FLAT;
    if (peaks) {
      const from = Math.floor((i / bars) * PEAK_COUNT);
      const to = Math.max(from + 1, Math.floor(((i + 1) / bars) * PEAK_COUNT));
      level = 0;
      for (let p = from; p < to; p++) level = Math.max(level, peaks[p]);
      level = Math.max(FLAT, level);
    }
    const lit = i >= highlightedFrom && i < highlighted;
    const upcoming = lit && i >= played;
    const x = i * (BAR_WIDTH + BAR_GAP);
    const up = level * (baseline - 2);
    const down = level * (height - baseline - 1);
    context.fillStyle = upcoming ? UPCOMING : lit ? PLAYED : UNPLAYED;
    context.fillRect(x, baseline - up, BAR_WIDTH, up);
    context.fillStyle = upcoming
      ? UPCOMING_REFLECTION
      : lit
        ? PLAYED_REFLECTION
        : UNPLAYED_REFLECTION;
    context.fillRect(x, baseline + 1, BAR_WIDTH, down);
  }

  if (markers) {
    context.fillStyle = '#fff';
    const shares = markers === 'end' ? [highlight] : [highlightFrom, highlight];
    for (const share of shares) {
      const at = share * width;
      const x = Math.min(width - 2, Math.max(0, at - 1));
      context.fillRect(x, 0, 2, height);
    }
  }
};

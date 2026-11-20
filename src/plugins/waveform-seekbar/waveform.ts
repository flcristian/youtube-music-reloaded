import { getDjFeatures } from '@/plugins/utils/renderer/dj-registry';

import { barCount, drawWaveform } from './draw';

import type { Sung } from './lyrics';
import type { MusicPlayer } from '@/types/music-player';

const HEIGHT = 56;
/** How close (CSS px) to the end line a press grabs it instead of seeking. */
const GRAB_DISTANCE = 18;
/**
 * The end can't be moved closer to the current position than the
 * end-of-song crossfade plus this.
 */
const MIN_REMAINING = 5;

/**
 * A SoundCloud-style waveform drawn in place of the player's progress bar,
 * with the part that plays in red (played: solid, still to play: lighter)
 * and the rest in white. Click or drag on it to seek; drag the white line
 * at the part's end to change where the song ends.
 */
export class Waveform {
  readonly canvas = document.createElement('canvas');
  private peaks?: Float32Array;
  private sung: Sung[] = [];
  private frame?: number;
  private lastKey = '';
  private dragging: 'seek' | 'end' | undefined;

  constructor(private readonly api: MusicPlayer) {
    Object.assign(this.canvas.style, {
      position: 'absolute',
      left: '0',
      bottom: '100%',
      width: '100%',
      height: `${HEIGHT}px`,
      cursor: 'pointer',
      zIndex: '2',
      background: 'var(--ytmusic-player-bar-background, #212121)',
    });
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
  }

  setPeaks(peaks: Float32Array | undefined) {
    this.peaks = peaks;
    this.lastKey = '';
  }

  /** Where the song is sung (song seconds), shown in blue. */
  setSung(sung: Sung[]) {
    this.sung = sung;
    this.lastKey = '';
  }

  show(parent: HTMLElement) {
    parent.append(this.canvas);
    const tick = () => {
      this.draw();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame ??= requestAnimationFrame(tick);
  }

  hide() {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.canvas.remove();
  }

  private progress() {
    const duration = this.api.getDuration();
    if (!(duration > 0)) return 0;
    return Math.min(1, Math.max(0, this.api.getCurrentTime() / duration));
  }

  /** The playing part as shares of the song (whole song if none). */
  private part() {
    const duration = this.api.getDuration();
    const part = getDjFeatures()?.currentPart();
    if (!part || !(duration > 0)) return { from: 0, to: 1 };
    const share = (seconds: number) =>
      Math.min(1, Math.max(0, seconds / duration));
    return {
      from: share(part.start),
      to: part.end === undefined ? 1 : share(part.end),
    };
  }

  private draw() {
    const width = this.canvas.clientWidth;
    if (!width) return;
    const progress = this.progress();
    const { from, to } = this.part();
    const bars = barCount(width);
    const playedBars = Math.round(progress * bars);
    const fromBar = Math.round(from * bars);
    const toBar = Math.round(to * bars);
    // Can't move the end without the crossfade plugin.
    const endHandle = getDjFeatures() ? 'end' : false;

    // Only repaint when something visible changed.
    const ratio = window.devicePixelRatio || 1;
    const duration = this.api.getDuration();
    const lead = getDjFeatures()?.transitionLead();
    const transitionAt =
      lead !== undefined && duration > 0
        ? Math.max(0, to - (lead / duration))
        : undefined;
    const transitionBar =
      transitionAt === undefined ? -1 : Math.round(transitionAt * width);
    const key = `${transitionBar}|${width}|${ratio}|${playedBars}|${fromBar}|${toBar}|${this.peaks ? 1 : 0}|${endHandle}|${this.sung.length}|${duration > 0}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const sung =
      duration > 0
        ? this.sung.map((span) => ({
            from: span.start / duration,
            to: span.end / duration,
            voice: span.voice,
          }))
        : [];
    drawWaveform(
      this.canvas,
      this.peaks,
      to,
      from,
      endHandle,
      progress,
      sung,
      transitionAt,
    );
  }

  /** Song share under the pointer. */
  private shareAt(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  }

  private nearEnd(event: PointerEvent) {
    if (!getDjFeatures()) return false;
    const rect = this.canvas.getBoundingClientRect();
    const offset = this.part().to * rect.width;
    const endX = rect.left + offset;
    return Math.abs(event.clientX - endX) <= GRAB_DISTANCE;
  }

  private moveEnd(event: PointerEvent) {
    const dj = getDjFeatures();
    const duration = this.api.getDuration();
    if (!dj || !(duration > 0)) return;
    const crossfade = dj.getCrossfadeConfig();
    const fade = crossfade.autoEnabled ? crossfade.autoDuration : 0;
    const lock = fade + MIN_REMAINING;
    const earliest = Math.min(duration, this.api.getCurrentTime() + lock);
    const end = Math.max(earliest, this.shareAt(event) * duration);
    // Dragged to the very end: play until the song's end.
    dj.setPartEnd(end >= duration - 0.5 ? undefined : end);
  }

  private seekTo(event: PointerEvent) {
    const duration = this.api.getDuration();
    if (duration > 0) this.api.seekTo(this.shareAt(event) * duration);
  }

  private apply(event: PointerEvent) {
    if (this.dragging === 'end') this.moveEnd(event);
    else this.seekTo(event);
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.dragging = this.nearEnd(event) ? 'end' : 'seek';
    this.canvas.setPointerCapture(event.pointerId);
    this.apply(event);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.dragging) {
      this.apply(event);
      return;
    }
    this.canvas.style.cursor = this.nearEnd(event) ? 'ew-resize' : 'pointer';
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (!this.dragging) return;
    this.apply(event);
    this.dragging = undefined;
  };
}

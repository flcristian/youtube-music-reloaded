import { barCount, drawWaveform } from './draw';

import type { MusicPlayer } from '@/types/music-player';

const HEIGHT = 56;

/**
 * A SoundCloud-style waveform drawn in place of the player's progress bar,
 * with the played part highlighted. Click or drag on it to seek.
 */
export class Waveform {
  readonly canvas = document.createElement('canvas');
  private peaks?: Float32Array;
  private frame?: number;
  private lastKey = '';
  private dragging = false;

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

  private draw() {
    const width = this.canvas.clientWidth;
    if (!width) return;
    const progress = this.progress();
    const playedBars = Math.round(progress * barCount(width));

    // Only repaint when something visible changed.
    const ratio = window.devicePixelRatio || 1;
    const key = `${width}|${ratio}|${playedBars}|${this.peaks ? 1 : 0}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    drawWaveform(this.canvas, this.peaks, progress);
  }

  private seekTo(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const share = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width),
    );
    const duration = this.api.getDuration();
    if (duration > 0) this.api.seekTo(share * duration);
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.dragging = true;
    this.canvas.setPointerCapture(event.pointerId);
    this.seekTo(event);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.dragging) this.seekTo(event);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    this.seekTo(event);
  };
}

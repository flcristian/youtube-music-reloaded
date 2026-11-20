/**
 * Transition view: a small panel showing two songs around where they play
 * (their onsets, with beat, bar and phrase marks), with their tempo and
 * key: the playing song and the next one, or while a transition runs, the
 * song leaving and the one coming in, and how far the transition is.
 * Cmd+Shift+T shows or hides it.
 */
import { t } from '@/i18n';
import {
  BAR,
  FPS,
  marksBetween,
  PHRASE,
  type Tempo,
  tempoCache,
} from '@/plugins/waveform-seekbar/tempo';

import { nextInQueue, versionsOf } from './queue';

import type { Crossfader } from './crossfader';
import type { MusicPlayer } from '@/types/music-player';

/** Seconds shown either side of where each song plays. */
const SPAN = 6;
/** How often the panel checks whether to show, in ms. */
const POLL = 500;
/** Gap (px) between the panel and the song's waveform under it. */
const GAP = 8;
/** Bottom offset (px) when the waveform isn't there. */
const FALLBACK_BOTTOM = 88;

/** Where the panel was dragged to (kept in this browser). */
const POSITION_KEY = 'seamless-crossfade.transition-view.position';

interface Position {
  left: number;
  top: number;
}

const loadPosition = (): Position | undefined => {
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY) ?? 'null') as
      | Partial<Position>
      | null;
    return typeof saved?.left === 'number' && typeof saved.top === 'number'
      ? { left: saved.left, top: saved.top }
      : undefined;
  } catch {
    return undefined;
  }
};

const savePosition = (position: Position | undefined) => {
  try {
    if (position) localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    else localStorage.removeItem(POSITION_KEY);
  } catch {}
};

/** How far from the window's bottom the panel goes: above the waveform. */
const bottomOffset = () => {
  const waveform = document.querySelector('ytmusic-player-bar canvas');
  const top = waveform?.getBoundingClientRect().top;
  return top && top > 0
    ? window.innerHeight - top + GAP
    : FALLBACK_BOTTOM;
};

const tempoOf = (videoId: string | undefined) => {
  if (!videoId) return undefined;
  for (const id of versionsOf(videoId)) {
    const tempo = tempoCache.get(id);
    if (tempo) return tempo;
  }
  return undefined;
};

const describe = (tempo: Tempo | undefined) =>
  tempo
    ? [
        `${Math.round(tempo.bpm)} BPM`,
        ...(tempo.key ? [tempo.key.camelot] : []),
      ].join(' · ')
    : '…';

/**
 * One song's lane: its onsets around `time`, its marks, and the playhead
 * at `playhead` (`time` by default).
 */
const drawLane = (
  canvas: HTMLCanvasElement,
  tempo: Tempo | undefined,
  time: number,
  colour: string,
  playhead = time,
) => {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width * ratio) canvas.width = width * ratio;
  if (canvas.height !== height * ratio) canvas.height = height * ratio;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!tempo) return;
  const from = time - SPAN;
  const to = time + SPAN;
  const x = (at: number) => ((at - from) / (to - from)) * width;

  // Onsets, as mirrored bars (scaled to the loudest in view).
  const { envelope } = tempo;
  const first = Math.max(0, Math.floor(from * FPS));
  const last = Math.min(envelope.length, Math.ceil(to * FPS));
  let top = 1e-9;
  for (let i = first; i < last; i++) top = Math.max(top, envelope[i]);
  const middle = height / 2;
  context.fillStyle = colour;
  const columns = Math.floor(width / 2);
  for (let column = 0; column < columns; column++) {
    const start = from + ((column / columns) * (to - from));
    const end = from + (((column + 1) / columns) * (to - from));
    let peak = 0;
    for (
      let i = Math.max(0, Math.floor(start * FPS));
      i < Math.min(envelope.length, Math.ceil(end * FPS));
      i++
    ) {
      peak = Math.max(peak, envelope[i]);
    }
    const size = Math.max(1, (peak / top) * (middle - 2));
    context.globalAlpha = (start + end) / 2 < playhead ? 0.45 : 0.9;
    context.fillRect(column * 2, middle - size, 1.5, size * 2);
  }
  context.globalAlpha = 1;

  // Beats, bars (stronger) and phrases (accent).
  const mark = (at: number, style: string, lineWidth: number) => {
    context.strokeStyle = style;
    context.lineWidth = lineWidth;
    context.beginPath();
    context.moveTo(x(at), 0);
    context.lineTo(x(at), height);
    context.stroke();
  };
  for (const beat of tempo.beats) {
    if (beat >= from && beat <= to) mark(beat, 'rgba(255,255,255,0.18)', 1);
  }
  for (const bar of marksBetween(tempo, from, to, BAR)) {
    mark(bar, 'rgba(255,255,255,0.5)', 1.5);
  }
  for (const phrase of marksBetween(tempo, from, to, PHRASE)) {
    mark(phrase, '#ffd166', 2);
  }
  // Where it plays (or will start).
  mark(playhead, '#fff', 2);
};

const isToggleShortcut = (event: KeyboardEvent) =>
  (event.metaKey || event.ctrlKey) &&
  event.shiftKey &&
  !event.altKey &&
  event.code === 'KeyT';

export class TransitionView {
  private timer?: ReturnType<typeof setInterval>;
  private host?: HTMLElement;
  private frame?: number;

  constructor(
    private readonly crossfader: Crossfader,
    private readonly api: MusicPlayer,
    private readonly enabled: () => boolean,
    /** Show or hide it (saved). */
    private readonly setEnabled: (enabled: boolean) => void,
  ) {}

  start() {
    this.timer = setInterval(() => this.poll(), POLL);
    window.addEventListener('keydown', this.onShortcut, true);
    this.poll();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    window.removeEventListener('keydown', this.onShortcut, true);
    this.close();
  }

  private readonly onShortcut = (event: KeyboardEvent) => {
    if (!isToggleShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const show = !this.enabled();
    this.setEnabled(show);
    if (show) this.open();
    else this.close();
  };

  private poll() {
    if (this.enabled() && !this.host) this.open();
    if (!this.enabled() && this.host) this.close();
  }

  private open() {
    if (this.host) return;
    const host = document.createElement('transition-view');
    this.host = host;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .panel {
          position: fixed; right: 16px; bottom: ${FALLBACK_BOTTOM}px; z-index: 9000;
          width: 520px; max-width: calc(100vw - 32px); padding: 12px 14px 14px; border-radius: 12px;
          background: #181818; color: #fff;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
          font: 13px Roboto, Arial, sans-serif;
          cursor: grab; user-select: none; touch-action: none;
        }
        .panel.dragging { cursor: grabbing; }
        .head { display: flex; justify-content: space-between; margin-bottom: 6px; color: rgba(255,255,255,0.75); }
        .lane { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; }
        .label { display: flex; justify-content: space-between; color: rgba(255,255,255,0.6); font-variant-numeric: tabular-nums; }
        canvas { width: 100%; height: 64px; display: block; border-radius: 4px; background: rgba(255,255,255,0.05); }
        .progress { height: 4px; margin-top: 12px; border-radius: 2px; background: rgba(255,255,255,0.12); overflow: hidden; }
        .progress div { height: 100%; width: 0; background: #f03; }
      </style>
      <div class="panel">
        <div class="head"><span class="style"></span><span class="length"></span></div>
        <div class="lane"><div class="label"><span class="top-title"></span><span class="top-info"></span></div><canvas class="top"></canvas></div>
        <div class="lane"><div class="label"><span class="bottom-title"></span><span class="bottom-info"></span></div><canvas class="bottom"></canvas></div>
        <div class="progress"><div></div></div>
      </div>`;
    const $ = <T extends Element>(selector: string) =>
      root.querySelector<T>(selector)!;
    const text = (selector: string, value: string) => {
      const element = $(selector);
      if (element.textContent !== value) element.textContent = value;
    };
    const label = (name: string) =>
      t(`plugins.seamless-crossfade.transition.${name}`);
    document.body.append(host);

    const panel = $<HTMLElement>('.panel');
    // Dragged somewhere: there (kept inside the window); else above the
    // song's waveform.
    let position = loadPosition();
    let grab: { x: number; y: number } | undefined;
    panel.addEventListener('pointerdown', (event) => {
      const rect = panel.getBoundingClientRect();
      grab = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      panel.setPointerCapture(event.pointerId);
      panel.classList.add('dragging');
      event.preventDefault();
    });
    panel.addEventListener('pointermove', (event) => {
      if (!grab) return;
      position = { left: event.clientX - grab.x, top: event.clientY - grab.y };
    });
    const drop = () => {
      if (!grab) return;
      grab = undefined;
      panel.classList.remove('dragging');
      if (position) savePosition(position);
    };
    panel.addEventListener('pointerup', drop);
    panel.addEventListener('pointercancel', drop);
    // Double-click: back above the song's waveform.
    panel.addEventListener('dblclick', () => {
      position = undefined;
      savePosition(undefined);
      Object.assign(panel.style, { left: '', top: '', right: '', bottom: '' });
    });
    const place = () => {
      if (!position) {
        const bottom = `${bottomOffset()}px`;
        if (panel.style.bottom !== bottom) panel.style.bottom = bottom;
        return;
      }
      const left = Math.min(
        Math.max(0, position.left),
        Math.max(0, window.innerWidth - panel.offsetWidth),
      );
      const top = Math.min(
        Math.max(0, position.top),
        Math.max(0, window.innerHeight - panel.offsetHeight),
      );
      Object.assign(panel.style, {
        left: `${left}px`,
        top: `${top}px`,
        right: 'auto',
        bottom: 'auto',
      });
    };
    const draw = () => {
      if (this.host !== host) return;
      place();
      const playing = this.api.getVideoData()?.video_id;
      const transition = this.crossfader.transition;
      if (transition) {
        const incoming =
          playing && !versionsOf(playing).includes(transition.outgoing.videoId)
            ? tempoOf(playing)
            : undefined;
        const outgoing = tempoOf(transition.outgoing.videoId);
        text(
          '.style',
          t(`plugins.seamless-crossfade.settings.style.${transition.style}`),
        );
        text('.length', `${transition.length.toFixed(1)} s`);
        text('.top-title', label('out'));
        text('.top-info', describe(outgoing));
        text('.bottom-title', label('in'));
        text('.bottom-info', describe(incoming));
        const { audio, shift } = transition.outgoing;
        drawLane($('.top'), outgoing, audio.currentTime - shift, '#9ad0ff');
        drawLane($('.bottom'), incoming, this.api.getCurrentTime(), '#ff8fa3');
        const share = Math.min(
          1,
          (performance.now() - transition.startedAt) / 1000 / transition.length,
        );
        $<HTMLElement>('.progress div').style.width = `${share * 100}%`;
      } else {
        // Between transitions: the playing song, and where the next starts.
        const current = tempoOf(playing);
        const nextId = nextInQueue(playing);
        const next = tempoOf(nextId);
        const start = nextId
          ? (this.crossfader.scheduledStart?.(nextId) ?? 0)
          : 0;
        text('.style', label('idle'));
        text('.length', '');
        text('.top-title', label('playing'));
        text('.top-info', describe(current));
        text('.bottom-title', label('next'));
        text('.bottom-info', nextId ? describe(next) : '');
        drawLane($('.top'), current, this.api.getCurrentTime(), '#9ad0ff');
        drawLane($('.bottom'), next, start + SPAN, '#ff8fa3', start);
        $<HTMLElement>('.progress div').style.width = '0';
      }
      this.frame = requestAnimationFrame(draw);
    };
    draw();
  }

  private close() {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.host?.remove();
    this.host = undefined;
  }
}

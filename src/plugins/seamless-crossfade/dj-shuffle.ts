/**
 * DJ shuffle: while a shuffled run plays, its songs are analysed in the
 * background, and as each song starts, the analysed song that mixes best
 * with it (tempo, key, energy) is moved up to play next.
 */
import { loadTempo } from '@/plugins/waveform-seekbar/peaks';
import {
  keysFit,
  type Tempo,
  tempoCache,
} from '@/plugins/waveform-seekbar/tempo';

import { moveToNext, upcomingSongs, versionsOf } from './queue';
import {
  STYLE_LENGTHS,
  type TransitionOverride,
  type TransitionStyle,
} from './settings';

import type { MusicPlayer } from '@/types/music-player';

/** How long to wait (ms) when no song needs analysing. */
const IDLE_WAIT = 5000;
/** How often the playing song is checked, in ms. */
const CHECK_EVERY = 2000;
/** The next song isn't changed this close (s) to the playing one's end. */
const SETTLED = 40;
/** A tempo this far off (ratio, either way) counts as one point… */
const TEMPO_STEP = 0.06;
/** …a key clash as this many, and energy this many times apart as one. */
const KEY_CLASH = 1;
const ENERGY_STEP = 1.5;
const ENERGY_WEIGHT = 0.5;

const tempoOf = (videoId: string) => {
  for (const id of versionsOf(videoId)) {
    const tempo = tempoCache.get(id);
    if (tempo) return tempo;
  }
  return undefined;
};

/** How busy a song is: its average onset strength. */
const energyOf = (tempo: Tempo) => {
  let sum = 0;
  for (const value of tempo.envelope) sum += value;
  return sum / Math.max(1, tempo.envelope.length);
};

/** Tempos this close (ratio, with half/double time) can be beat-matched. */
const MATCHABLE = 0.06;
/** Energy this many times lower / higher counts as calmer / livelier. */
const CALMER = 0.7;
const LIVELIER = 1.3;

/** How far apart two tempos are (log2 ratio, half/double time allowed). */
const tempoGap = (playing: Tempo, next: Tempo) =>
  Math.min(
    ...[0.5, 1, 2].map((factor) =>
      Math.abs(Math.log2((next.bpm * factor) / playing.bpm)),
    ),
  );

/** The transition that suits going from `playing` to `next`. */
export const transitionBetween = (
  playing: Tempo,
  next: Tempo,
): TransitionOverride => {
  const matchable = tempoGap(playing, next) <= Math.log2(1 + MATCHABLE);
  const keysMix =
    !playing.key || !next.key || keysFit(playing.key, next.key);
  const energy = (energyOf(next) || 1e-9) / (energyOf(playing) || 1e-9);
  let style: TransitionStyle;
  let beats: number | undefined;
  if (matchable) {
    // Beat-matched: a long bass-swap blend, or a filter blend that hides
    // clashing keys.
    style = keysMix ? 'bass-swap' : 'filter';
    beats = keysMix ? 32 : 16;
  } else if (energy < CALMER) {
    style = 'echo-out';
    beats = 8;
  } else if (energy > LIVELIER) {
    style = 'filter-stop';
  } else {
    style = 'tape-stop';
    beats = 2;
  }
  const range = STYLE_LENGTHS[style];
  const seconds = beats === undefined ? range.min : (beats * 60) / playing.bpm;
  return {
    style,
    length: Math.min(range.max, Math.max(range.min, seconds)),
  };
};

/** How badly `next` follows `playing` (0: perfectly). */
const mismatch = (playing: Tempo, next: Tempo) => {
  // Half or double time mixes too.
  const tempo = tempoGap(playing, next);
  const key =
    playing.key && next.key
      ? keysFit(playing.key, next.key)
        ? 0
        : KEY_CLASH
      : KEY_CLASH / 2;
  const energy = Math.abs(
    Math.log((energyOf(next) || 1e-9) / (energyOf(playing) || 1e-9)),
  );
  return (
    (tempo / Math.log2(1 + TEMPO_STEP)) +
    key +
    (ENERGY_WEIGHT * (energy / Math.log(ENERGY_STEP)))
  );
};

export class DjShuffle {
  private songs = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  /** The playing song already given a next song. */
  private arranged?: string;
  private run = 0;

  constructor(
    private readonly api: MusicPlayer,
    /** Where the playing song ends (s), if a part of it plays. */
    private readonly partEnd: (videoId: string) => number | undefined,
    /** Use this transition into this song (unless the user chose one). */
    private readonly suggest: (
      videoId: string,
      transition: TransitionOverride,
    ) => void,
  ) {}

  /** Arrange these songs (already queued, shuffled) as they play. */
  start(videoIds: string[]) {
    this.stop();
    const run = ++this.run;
    this.songs = new Set(videoIds);
    this.timer = setInterval(() => this.check(), CHECK_EVERY);
    this.analyse(run).catch(() => {});
  }

  stop() {
    this.run++;
    clearInterval(this.timer);
    this.timer = undefined;
    this.songs.clear();
    this.arranged = undefined;
  }

  /** Analyse the run's songs, next ones first, one at a time. */
  private async analyse(run: number) {
    for (;;) {
      if (run !== this.run) return;
      const next = upcomingSongs(this.api.getVideoData()?.video_id)
        .filter((ids) => ids.some((id) => this.songs.has(id)))
        .find((ids) => !ids.some((id) => tempoCache.has(id)));
      if (!next) {
        // All analysed (or still being queued): look again in a while.
        await new Promise((resolve) => setTimeout(resolve, IDLE_WAIT));
        continue;
      }
      await loadTempo(next[0]).catch(() => undefined);
      // Couldn't analyse it: don't try again.
      if (!tempoCache.has(next[0])) tempoCache.set(next[0], null);
      this.arranged = undefined;
    }
  }

  /** Give the playing song the best-mixing next song (until settled). */
  private check() {
    const playing = this.api.getVideoData()?.video_id;
    if (!playing) return;
    if (!versionsOf(playing).some((id) => this.songs.has(id))) {
      // Something else plays now: the run is over.
      const left = upcomingSongs(this.api.getVideoData()?.video_id).some((ids) =>
        ids.some((id) => this.songs.has(id)),
      );
      if (!left) this.stop();
      return;
    }
    if (this.arranged === playing) return;
    const end = this.partEnd(playing) ?? this.api.getDuration();
    if (end - this.api.getCurrentTime() < SETTLED) return;
    const current = tempoOf(playing);
    if (!current) return;
    let best: { id: string; score: number } | undefined;
    for (const ids of upcomingSongs(this.api.getVideoData()?.video_id)) {
      const id = ids.find((version) => this.songs.has(version));
      if (!id) continue;
      const tempo = tempoOf(id);
      if (!tempo) continue;
      const score = mismatch(current, tempo);
      if (!best || score < best.score) best = { id, score };
    }
    if (!best) return;
    moveToNext(best.id, playing);
    const chosen = tempoOf(best.id);
    if (chosen) this.suggest(best.id, transitionBetween(current, chosen));
    // Settled once every remaining song was considered.
    const unanalysed = upcomingSongs(this.api.getVideoData()?.video_id).some(
      (ids) =>
        ids.some((id) => this.songs.has(id)) &&
        !ids.some((id) => tempoCache.has(id)),
    );
    if (!unanalysed) this.arranged = playing;
  }
}

/**
 * Keeps a live, paused copy of the player's audio stream in a hidden
 * <audio> element, so the outgoing song can keep playing the instant the
 * player drops it (manual skip, click on another song, or our own
 * end-of-song skip).
 *
 * Every operation the YouTube Music player does on its audio SourceBuffer
 * (append, remove, abort, timestampOffset, append windows, changeType) is
 * replayed in order on a mirror SourceBuffer. Both share the same media
 * timeline, so the mirror can resume at exactly `video.currentTime`.
 *
 * No extra network requests: only data the player already downloaded.
 */

type Bytes = Uint8Array<ArrayBuffer>;

type Op =
  | { kind: 'append'; data: Bytes }
  | { kind: 'remove'; start: number; end: number }
  | { kind: 'abort' }
  | { kind: 'offset'; value: number }
  | { kind: 'windowStart'; value: number }
  | { kind: 'windowEnd'; value: number }
  | { kind: 'changeType'; mime: string };

/** Keep at most this much already-played audio in the mirror. */
const KEEP_BEHIND = 15;

const copyBytes = (source: BufferSource): Bytes =>
  source instanceof ArrayBuffer
    ? new Uint8Array(source.slice(0))
    : new Uint8Array(
        source.buffer.slice(
          source.byteOffset,
          source.byteOffset + source.byteLength,
        ),
      );

const isWebmInit = (b: Bytes) =>
  b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;

const isMp4Init = (b: Bytes) => {
  if (b.length < 8) return false;
  const box = String.fromCharCode(b[4], b[5], b[6], b[7]);
  return box === 'ftyp' || box === 'moov';
};

const includesAscii = (b: Bytes, text: string) => {
  const needle = Array.from(text, (c) => c.charCodeAt(0));
  outer: for (let i = 0; i <= b.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (b[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
};

/** For SourceBuffers created before our hooks: guess the mime from the init segment. */
const guessAudioMime = (init: Bytes) => {
  if (isMp4Init(init) && includesAscii(init, 'soun')) {
    return 'audio/mp4; codecs="mp4a.40.2"';
  }
  if (isWebmInit(init)) {
    if (includesAscii(init, 'A_OPUS')) return 'audio/webm; codecs="opus"';
    if (includesAscii(init, 'A_VORBIS')) return 'audio/webm; codecs="vorbis"';
  }
  return undefined;
};

const waitForUpdate = (sb: SourceBuffer) =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
      sb.removeEventListener('updateend', done);
      sb.removeEventListener('error', fail);
      resolve();
    };
    const fail = () => {
      sb.removeEventListener('updateend', done);
      sb.removeEventListener('error', fail);
      reject(new Error('SourceBuffer error'));
    };
    sb.addEventListener('updateend', done);
    sb.addEventListener('error', fail);
  });

/** Mirrors one player SourceBuffer into its own hidden <audio> element. */
export class StreamMirror {
  readonly audio = new Audio();
  broken = false;

  private readonly ms = new MediaSource();
  private readonly url = URL.createObjectURL(this.ms);
  private sb?: SourceBuffer;
  private readonly queue: Op[] = [];
  private pumping = false;
  /** Song bounds on the media timeline, keyed by start. */
  private readonly songs = new Map<number, { start: number; end: number }>();

  constructor(
    private mime: string,
    private readonly origAppend: SourceBuffer['appendBuffer'],
    private readonly getPlaybackTime: () => number,
    onCreated: (sb: SourceBuffer) => void,
  ) {
    this.audio.preload = 'auto';
    this.audio.src = this.url;
    this.ms.addEventListener(
      'sourceopen',
      () => {
        try {
          this.sb = this.ms.addSourceBuffer(this.mime);
          onCreated(this.sb);
          this.pump().catch(() => {});
        } catch (err) {
          this.fail(err);
        }
      },
      { once: true },
    );
  }

  push(op: Op) {
    if (this.broken) return;
    this.queue.push(op);
    this.pump().catch(() => {});
  }

  /** Track song bounds from the player's append windows (gapless playback). */
  noteWindow(start: number, end: number) {
    const key = Math.round(start * 1000);
    let song = this.songs.get(key);
    if (!song) {
      // A song without an explicit end ends where the next one begins.
      for (const previous of this.songs.values()) {
        if (previous.start < start && !Number.isFinite(previous.end)) {
          previous.end = start;
        }
      }
      song = { start, end };
      this.songs.set(key, song);
      while (this.songs.size > 4) {
        this.songs.delete(this.songs.keys().next().value!);
      }
    }
    if (Number.isFinite(end)) song.end = end;
  }

  /** End (media timeline) of the song playing at `time`; Infinity if unknown. */
  songEndAt(time: number) {
    let best: { start: number; end: number } | undefined;
    for (const song of this.songs.values()) {
      if (song.start <= time + 0.05 && (!best || song.start > best.start)) {
        best = song;
      }
    }
    return best?.end ?? Infinity;
  }

  /** Whether audio around `time` is in the mirror and playable. */
  covers(time: number, ahead = 0.5) {
    const { buffered } = this.audio;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= time + 0.05 && buffered.end(i) >= time + ahead) {
        return true;
      }
    }
    return false;
  }

  dispose() {
    this.broken = true;
    this.queue.length = 0;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    URL.revokeObjectURL(this.url);
  }

  private fail(err: unknown) {
    console.warn('[seamless-crossfade] mirror stopped', err);
    this.broken = true;
    this.queue.length = 0;
  }

  private async pump() {
    if (this.pumping || !this.sb) return;
    this.pumping = true;
    const sb = this.sb;
    try {
      while (this.queue.length > 0 && !this.broken) {
        const op = this.queue.shift()!;
        switch (op.kind) {
          case 'append':
            await this.append(sb, op.data);
            break;
          case 'remove':
            if (op.end > op.start) {
              sb.remove(op.start, op.end);
              await waitForUpdate(sb);
            }
            break;
          case 'abort':
            sb.abort();
            break;
          case 'offset':
            sb.timestampOffset = op.value;
            break;
          case 'windowStart':
            sb.appendWindowStart = op.value;
            break;
          case 'windowEnd':
            sb.appendWindowEnd = op.value;
            break;
          case 'changeType':
            this.mime = op.mime;
            sb.changeType(op.mime);
            break;
        }
      }
    } catch (err) {
      this.fail(err);
    } finally {
      this.pumping = false;
    }
  }

  private async append(sb: SourceBuffer, data: Bytes) {
    await this.evictPlayed(sb);
    try {
      this.origAppend.call(sb, data);
      await waitForUpdate(sb);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'QuotaExceededError')) {
        throw err;
      }
      await this.evictPlayed(sb, 2);
      this.origAppend.call(sb, data);
      await waitForUpdate(sb);
    }
  }

  /** Drop audio the player has already played, to stay under the quota. */
  private async evictPlayed(sb: SourceBuffer, keep = KEEP_BEHIND) {
    const until = this.getPlaybackTime() - keep;
    const { buffered } = sb;
    if (buffered.length > 0 && until > buffered.start(0)) {
      sb.remove(0, until);
      await waitForUpdate(sb);
    }
  }
}

/**
 * Hooks MediaSource/SourceBuffer and maintains a StreamMirror for the
 * player's audio SourceBuffer.
 */
export class MirrorManager {
  private installed = false;
  private readonly mirrors = new WeakMap<SourceBuffer, StreamMirror>();
  private readonly pendingMime = new WeakMap<SourceBuffer, string>();
  private readonly lastInit = new WeakMap<SourceBuffer, Bytes>();
  private readonly sourceOf = new WeakMap<StreamMirror, SourceBuffer>();
  private readonly ours = new WeakSet<SourceBuffer>();
  private latest?: StreamMirror;
  private origAppend!: SourceBuffer['appendBuffer'];

  constructor(private readonly getPlaybackTime: () => number) {}

  /** The mirror of the audio currently fed to the player, if any. */
  get current() {
    return this.latest && !this.latest.broken ? this.latest : undefined;
  }

  /**
   * Hand the current mirror over to the caller (to play the outgoing song).
   * The manager stops feeding it; a new one is created for the next stream.
   */
  release() {
    const mirror = this.current;
    this.latest = undefined;
    const source = mirror && this.sourceOf.get(mirror);
    if (source) this.mirrors.delete(source);
    return mirror;
  }

  install() {
    if (this.installed) return;
    this.installed = true;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const sbProto = SourceBuffer.prototype;

    // oxlint-disable-next-line typescript/unbound-method
    this.origAppend = sbProto.appendBuffer;
    const origAppend = this.origAppend;

    // oxlint-disable-next-line typescript/unbound-method
    const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime: string) {
      const sb = origAddSourceBuffer.call(this, mime);
      if (!self.ours.has(sb) && mime.startsWith('audio/')) {
        self.pendingMime.set(sb, mime);
      }
      return sb;
    };

    const forward = (sb: SourceBuffer, op: Op) => {
      if (self.ours.has(sb)) return;
      self.mirrors.get(sb)?.push(op);
    };

    sbProto.appendBuffer = function (data: BufferSource) {
      try {
        self.onAppend(this, data);
      } catch (err) {
        console.warn('[seamless-crossfade] mirror failed', err);
      }
      origAppend.call(this, data);
    };

    // oxlint-disable-next-line typescript/unbound-method
    const origRemove = sbProto.remove;
    sbProto.remove = function (start: number, end: number) {
      origRemove.call(this, start, end);
      forward(this, { kind: 'remove', start, end });
    };

    // oxlint-disable-next-line typescript/unbound-method
    const origAbort = sbProto.abort;
    sbProto.abort = function () {
      origAbort.call(this);
      forward(this, { kind: 'abort' });
    };

    // oxlint-disable-next-line typescript/unbound-method
    const origChangeType = sbProto.changeType;
    sbProto.changeType = function (mime: string) {
      origChangeType.call(this, mime);
      if (mime.startsWith('audio/')) {
        forward(this, { kind: 'changeType', mime });
      }
    };

    const hookSetter = (
      prop: 'timestampOffset' | 'appendWindowStart' | 'appendWindowEnd',
      kind: 'offset' | 'windowStart' | 'windowEnd',
    ) => {
      const desc = Object.getOwnPropertyDescriptor(sbProto, prop)!;
      Object.defineProperty(sbProto, prop, {
        ...desc,
        set(this: SourceBuffer, value: number) {
          desc.set!.call(this, value);
          forward(this, { kind, value });
        },
      });
    };
    hookSetter('timestampOffset', 'offset');
    hookSetter('appendWindowStart', 'windowStart');
    hookSetter('appendWindowEnd', 'windowEnd');
  }

  private onAppend(sb: SourceBuffer, data: BufferSource) {
    if (this.ours.has(sb)) return;

    let mirror = this.mirrors.get(sb);
    const bytes = copyBytes(data);
    const isInit = isMp4Init(bytes) || isWebmInit(bytes);

    if (!mirror) {
      let mime = this.pendingMime.get(sb);
      if (!mime) {
        // SourceBuffer created before our hooks: we can only start
        // mirroring once its next init segment shows it carries audio.
        if (!isInit) return;
        mime = guessAudioMime(bytes);
        if (!mime) return;
        this.pendingMime.set(sb, mime);
      }
      mirror = new StreamMirror(
        mime,
        this.origAppend,
        this.getPlaybackTime,
        (mirrorSb) => this.ours.add(mirrorSb),
      );
      // Start from the player's current state.
      mirror.push({ kind: 'windowEnd', value: sb.appendWindowEnd });
      mirror.push({ kind: 'windowStart', value: sb.appendWindowStart });
      mirror.push({ kind: 'offset', value: sb.timestampOffset });
      const init = this.lastInit.get(sb);
      if (!isInit && init) mirror.push({ kind: 'append', data: init });
      this.mirrors.set(sb, mirror);
      this.sourceOf.set(mirror, sb);
    }
    if (isInit) this.lastInit.set(sb, bytes);

    if (mirror !== this.latest) {
      // A new stream took over; drop the mirror of the previous one unless
      // it was released to play an outgoing song.
      this.latest?.dispose();
      this.latest = mirror;
    }

    mirror.noteWindow(sb.appendWindowStart, sb.appendWindowEnd);
    mirror.push({ kind: 'append', data: bytes });
  }
}

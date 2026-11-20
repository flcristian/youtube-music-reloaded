/**
 * The player queue, from YouTube Music's own queue state (the page's queue
 * rows can lag behind, e.g. marking an old song as playing).
 *
 * A queue entry can hold two versions of a song (the song and its music
 * video): either may be the one that plays, so they count as one.
 */
interface Renderer {
  videoId?: string;
  selected?: boolean;
}
interface Item {
  playlistPanelVideoRenderer?: Renderer;
  playlistPanelVideoWrapperRenderer?: {
    primaryRenderer?: { playlistPanelVideoRenderer?: Renderer };
    counterpart?: {
      counterpartRenderer?: { playlistPanelVideoRenderer?: Renderer };
    }[];
  };
}

interface Entry {
  /** Its versions' video ids (the main one first). */
  ids: string[];
  selected: boolean;
}

type QueueElement = HTMLElement & {
  queue?: {
    store?: {
      store?: {
        getState(): { queue?: { items?: Item[]; nextQueueItemId?: unknown } };
      };
    };
  };
  dispatch?: (action: { type: string; payload: unknown }) => void;
};

const queueElement = () => document.querySelector<QueueElement>('#queue');
const queueItems = () =>
  queueElement()?.queue?.store?.store?.getState().queue?.items ?? [];

const queueEntries = (): Entry[] => {
  const items = queueItems();
  return items.map((item) => {
    const wrapper = item.playlistPanelVideoWrapperRenderer;
    const versions = [
      item.playlistPanelVideoRenderer ??
        wrapper?.primaryRenderer?.playlistPanelVideoRenderer,
      ...(wrapper?.counterpart ?? []).map(
        (counterpart) => counterpart.counterpartRenderer?.playlistPanelVideoRenderer,
      ),
    ];
    return {
      ids: versions.flatMap((version) =>
        version?.videoId ? [version.videoId] : [],
      ),
      selected: versions.some((version) => version?.selected),
    };
  });
};

/** All versions of this song in the queue (just itself if not there). */
export const versionsOf = (videoId: string) =>
  queueEntries().find((entry) => entry.ids.includes(videoId))?.ids ?? [
    videoId,
  ];

/** Whether two ids are versions of the same song. */
export const sameSong = (a: string, b: string) =>
  a === b || versionsOf(a).includes(b);

/**
 * Where the playing song is in the queue. By its id when known: the
 * queue's own "selected" mark can still be on the previous song.
 */
const playingIndex = (entries: Entry[], playing?: string) => {
  if (playing) {
    const marked = entries.findIndex(
      (entry) => entry.selected && entry.ids.includes(playing),
    );
    if (marked >= 0) return marked;
    const found = entries.findIndex((entry) => entry.ids.includes(playing));
    if (found >= 0) return found;
  }
  return entries.findIndex((entry) => entry.selected);
};

/** The song after the playing one (`playing`: its id, if known). */
export const nextInQueue = (playing?: string) => {
  const entries = queueEntries();
  const current = playingIndex(entries, playing);
  return current < 0 ? undefined : entries[current + 1]?.ids[0];
};

/** The songs after the playing one (each: its versions' ids). */
export const upcomingSongs = (playing?: string) => {
  const entries = queueEntries();
  const current = playingIndex(entries, playing);
  return current < 0 ? [] : entries.slice(current + 1).map((entry) => entry.ids);
};

/**
 * Move this song (any version's id) to play right after the playing one.
 * False if it isn't queued after it, or the queue can't be changed.
 */
export const moveToNext = (videoId: string, playing?: string) => {
  const queue = queueElement();
  if (!queue?.dispatch) return false;
  const entries = queueEntries();
  const current = playingIndex(entries, playing);
  const index = entries.findIndex(
    (entry, i) => i > current && entry.ids.includes(videoId),
  );
  if (current < 0 || index < 0) return false;
  if (index === current + 1) return true;
  const item = queueItems()[index];
  queue.dispatch({ type: 'REMOVE_ITEM', payload: index });
  queue.dispatch({
    type: 'ADD_ITEMS',
    payload: {
      nextQueueItemId:
        queue.queue?.store?.store?.getState().queue?.nextQueueItemId,
      index: current + 1,
      items: [item],
      shuffleEnabled: false,
      shouldAssignIds: true,
    },
  });
  return true;
};

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

const queueEntries = (): Entry[] => {
  const queue = document.querySelector<
    HTMLElement & {
      queue?: {
        store?: { store?: { getState(): { queue?: { items?: Item[] } } } };
      };
    }
  >('#queue');
  const items = queue?.queue?.store?.store?.getState().queue?.items ?? [];
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

/** The song after the playing one (`playing`: its id, if known). */
export const nextInQueue = (playing?: string) => {
  const entries = queueEntries();
  let current = entries.findIndex((entry) => entry.selected);
  if (current < 0 && playing) {
    current = entries.findIndex((entry) => entry.ids.includes(playing));
  }
  return current < 0 ? undefined : entries[current + 1]?.ids[0];
};

/**
 * YouTube Music sometimes replaces the player's <video> element (after the
 * app has been open a while, or when a new playlist loads). Code that hooks
 * the element once at start-up then keeps listening to a detached one.
 *
 * Calls `onChange(video)` with the current element now and whenever it is
 * replaced; returns a function that stops watching.
 */
export const watchVideo = (onChange: (video: HTMLVideoElement) => void) => {
  let current: HTMLVideoElement | null = null;
  const check = () => {
    const video = document.querySelector<HTMLVideoElement>('video');
    if (!video || video === current) return;
    current = video;
    onChange(video);
  };
  check();
  const observer = new MutationObserver(check);
  const player = document.querySelector('#movie_player');
  if (player) observer.observe(player, { childList: true, subtree: true });
  // In case the whole player is replaced.
  const timer = setInterval(check, 2000);
  return () => {
    observer.disconnect();
    clearInterval(timer);
  };
};

/* Radial runtime configuration.
 *
 * Leave `proxy` empty and Radial runs exactly as it does today: a purely static
 * app with no backend. Point it at a deployed worker (see worker/) and the
 * now-playing track appears in the player bar for stations that broadcast it.
 *
 *   window.RADIAL = { proxy: "https://radial-nowplaying.<you>.workers.dev" };
 */
window.RADIAL = {
  proxy: ""
};

// Template fonts. build.mjs turns the project's fonts/fonts.json into inline @font-face rules
// (woff2 as data URIs), so the page needs no network. A @font-face only loads once some text
// uses it, which can land after the first screenshot; preloadFonts() starts every declared
// face at mount so the renderer's `document.fonts.ready` wait covers them all.
export function preloadFonts() {
  if (typeof document === 'undefined' || !document.fonts) return;
  document.fonts.forEach((face) => {
    if (face.status === 'unloaded') face.load().catch(() => {});
  });
}

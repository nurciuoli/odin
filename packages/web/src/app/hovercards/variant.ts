// Mockup switch: `?hc=b` in the address bar picks the richer layout. Remove once one layout is chosen.
export type HoverVariant = 'a' | 'b'
export const hoverVariant: HoverVariant =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('hc') === 'b'
    ? 'b'
    : 'a'

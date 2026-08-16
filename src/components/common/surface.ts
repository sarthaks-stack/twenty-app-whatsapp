/**
 * How tall a WhatsApp surface is allowed to be.
 *
 * **This is not a style preference, it is a workaround, and it is worth saying
 * why.** A widget in a Twenty page layout is sized by its content: the tab pane
 * is a grid whose row is computed from what we render (`grid-template-rows`
 * came back as `1932px` for a chat with eleven messages in a 724px pane). So
 * `height: 100%` resolves against an `auto` parent and means nothing — which is
 * how a chat with real history ended up 1 900px tall, scrolling the record page
 * instead of itself, with the composer somewhere below the fold. CLAUDE.md
 * names that failure outright.
 *
 * The obvious fix — measure the pane and size to it — is unavailable: probe P-6
 * found `getBoundingClientRect()` returns 0×0 in this sandbox and there is no
 * `ResizeObserver`. So the bound has to be something CSS can resolve without
 * being told, and the viewport is the only such thing.
 *
 * `height: 100%` is kept alongside it: where a parent *is* bounded the
 * percentage wins and the surface fills its pane exactly; where it is not, the
 * cap bites and the surface scrolls internally. Neither case grows the page.
 */
export const SURFACE_MAX_HEIGHT = '72vh';

/** Below this a chat is a viewport, not a conversation. */
export const SURFACE_MIN_HEIGHT = '420px';

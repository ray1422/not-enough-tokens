# UI rules

## Corners

Rounded corners are curvature-continuous (G2), never a circular arc. The rule is about how rounded corners are drawn; ridges, glyph strokes, chevrons and other deliberate points are fine.

- CSS: `corner-shape: squircle` with the `--r-*` radius tokens. No raw `border-radius` values. Under `@supports (corner-shape: squircle)` the tokens are about 1.6× larger, since a squircle looks smaller than an arc of the same radius. Dots and the logo glint keep `corner-shape: round`.
- SVG: cubic Béziers whose handles keep zero curvature at the joins, not `Q` or arc commands. This includes the chart's bar tops.

## Color and type

- Anthropic's public brand guidelines: warm neutrals, Poppins for UI, Lora for prose, the monospace face for numbers.
- The accent is shifted from the brand orange toward copper to match the logo (`--accent`, `--accent-strong`, `--link`).
- Status colors: `--good`, `--danger`, and `--warn`, an ochre pushed toward yellow (hue ~46° against the accent's ~24°) so a warning never reads as the accent. Each is at least 4.5:1 on `--bg` and `--surface` in both modes.
- Every color is a token in `style.css`, defined for light and dark, both under `prefers-color-scheme` and under `[data-theme]` (the theme switch).
- The chart palette `--s1`…`--s5` was validated for color-vision deficiency in both modes. Re-validate before changing a series color.

## Text

All user-visible text goes through `t()` in `web/i18n.js`, with `zh-TW` and `en` entries. Keep explanations that only matter to developers in code comments or these docs, not on screen.

Don't use `window.confirm`/`alert`/`prompt`: embedded browsers suppress them. Use the in-app modal.

## Logo

- Source: `design/logo/` (gitignored). `make-logo.py` (fontTools, Poppins outlines) writes `build/icon.svg`, `web/icon.svg` and `web/logo*.svg`; `render-svg.mjs` renders the PNG with Electron's Chromium.
- A copper arcade token ("GOOD FOR 1M TOKENS", raised rim with dots) in front of a slot machine, token at the lower left.
- Light always comes from the top left.
- The header token's hover tilt is real CSS 3D (`web/logo-fx.js`): the perspective is centered on the coin, the edge is a stack of discs, and Lambert diffuse plus Blinn–Phong specular are computed per frame from the face normal. A damped spring drives the angle and the frame loop stops once it settles; reduced motion keeps it still.

## dmg background

- Source: `design/dmg/make-dmg-bg.py` (gitignored, reuses the logo generator) writes `build/dmg-background.svg`; render `build/dmg-background.png` (660×460) and `@2x` with `render-svg.mjs`. electron-builder merges them into a retina `.background.tiff`.
- A night-time arcade: the NOT ENOUGH TOKENS marquee, an INSERT TOKEN chase-light arrow from the app to Applications, spent tokens on the carpet, CREDITS 00.
- Finder draws icon labels in black or white depending on its appearance, so they sit on mid-tone brass plates (both above 4:1). Icon positions in `package.json` (`dmg.contents`) must match `APP`/`APPS` in the script.
- The window height includes the title bar, so the canvas runs past the visible bottom; keep content above y≈410.

## Desktop window (Electron)

- The top bar doubles as the title bar. macOS draws its traffic lights over it (`hiddenInset`). On Linux, Electron draws the window buttons as `titleBarOverlay`, in the order of the desktop's button layout; `.app-linux .topbar` leaves room via `env(titlebar-area-*)` and sends its colors through `preload.cjs` whenever the theme changes.
- No menu bar off macOS (About is in Settings). macOS keeps the app, Edit and Window menus: ⌘C/⌘V/⌘W only work through visible menu items.

## Custom page scrollbar

The native page scrollbar always spans the full window height, so in the Linux app it would sit under the window buttons. `web/scrollbar.js` can hide it and draw one after macOS's overlay scrollbar; the page still scrolls natively. Settings → UI tuning turns it on or off (default on everywhere but macOS) and picks the mode below; both are stored per browser like the theme.

- Overlay: no layout width. Runs from the top bar's bottom edge to the console's top edge; the thumb keeps 3px from both ends and is at least 32px long. Hidden when nothing scrolls.
- Thumb 6px wide, `--text` at 45%; on hover or drag it widens to 9px at 60% over a translucent `--bg` track with a `--border` hairline on its left.
- Shows on scroll only (hovering the edge doesn't reveal it, so it never covers content unasked); fades 1.2s after the last scroll, never while hovered or dragged. Reduced motion drops the fades, not the delay.
- "Always show" keeps the track and thumb, and `main`/settings leave 15px free.
- Drag the thumb; a click on the track pages toward it. Only the bar takes pointer events, and only while shown.
- Inner scrollers (tables, the console) keep native thin scrollbars in the same color.

## Meta lines

Card meta (`ssh … · last IP … · synced … · data since …`) wraps between parts, never inside one unless it alone is too long. Each part carries its `·` in front; `.mis` is shifted left by the separator's width inside an `overflow: hidden` box, so the separator that would start a line is clipped and no line ends or starts with one.

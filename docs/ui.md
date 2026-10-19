# UI rules

## Corners

Rounded corners are curvature-continuous (G2), never a circular arc. The rule is about how rounded corners are drawn; ridges, glyph strokes, chevrons and other deliberate points are fine.

- CSS: `corner-shape: squircle` with the `--r-*` radius tokens. No raw `border-radius` values. Under `@supports (corner-shape: squircle)` the tokens are about 1.6× larger, since a squircle looks smaller than an arc of the same radius. Dots and the logo glint keep `corner-shape: round`.
- SVG: cubic Béziers whose handles keep zero curvature at the joins, not `Q` or arc commands. This includes the chart's bar tops.

## Color and type

- Anthropic's public brand guidelines: warm neutrals, Poppins for UI, Lora for prose, the monospace face for numbers.
- The accent is shifted from the brand orange toward copper to match the logo (`--accent`, `--accent-strong`, `--link`).
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

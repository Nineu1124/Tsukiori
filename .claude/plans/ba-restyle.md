# Blue Archive (SCHALE OS) restyle of the Tsukiori workbench

## 1. What Blue Archive's UI language actually is

Blue Archive's interface is a *diegetic OS* — the player is "Sensei" operating
the SCHALE terminal. Its look decomposes into six reusable rules:

1. **Skewed geometry.** Buttons, tabs, badges and banners are parallelograms
   (roughly `skewX(-10deg)`), not rectangles. Corners are *chamfered* (cut at
   45°) rather than rounded.
2. **Hairline technical frames.** 1px cyan borders, corner brackets (`⌜ ⌝ ⌞ ⌟`),
   tick marks and crosshairs in the margins — like a blueprint or targeting HUD.
3. **Diagonal hatching.** 45° repeating stripe fills in empty regions, progress
   tracks, and behind headers.
4. **Micro-caps annotation.** Tiny uppercase Latin labels with wide tracking
   (`MISSION`, `ARCHIVE`, `SCHALE OS`) scattered as decoration, often paired
   with a numeric index (`01`, `05`).
5. **High-key blue-on-white.** Large flat white surfaces, one saturated cyan
   accent, deep navy text, and soft blue shadows. Accent yellow/red only for
   status.
6. **Snappy diagonal motion.** Slide-ins with slight overshoot, and a diagonal
   light sweep across elements on hover.

## 2. Verified gap against the current codebase

Measured in `apps/desktop/renderer/styles.css`:

| BA technique | current usage |
| --- | --- |
| `skew()` (parallelograms) | **0** |
| `repeating-linear-gradient` (hatching) | **0** |
| `clip-path` (chamfers) | 5 |
| `border-radius` | **86** |

So the current UI is *rounded where BA is angular*, and is missing both
signature techniques entirely. The palette, however, is already correct
(`#258fe8` cyan on `#f5fbff`) — this is a geometry and texture problem, not a
color problem.

## 3. Hard constraints discovered

- **`pnpm test:ui` is a gate** (`tests/ui/basic-ui.test.mjs`, 10 tests, green at
  baseline). It asserts on the *literal CSS text*, so the restyle must preserve:
  - palette tokens `#f5fbff #258fe8 #4bb9ef #20364b #526b80 #45c995 #f3c94f #ef6b7c #8e7bef`
  - metrics `--titlebar-height:40px`, `--rail-width:300px`,
    `--work-panel-width:360px`, `--terminal-height:220px`
  - the `grid-template` / `grid-template-rows` strings
  - `.chat-message.user{justify-self:end}`, `.chat-message.assistant{background:transparent}`
  - `.message-body{font-size:13px}`, `.composer textarea{font-size:13px}`,
    `.terminal-panel pre{font-size:12px}`
  - `tsukiori-button-sweep`, `tsukiori-interrupt-ready`, `tsukiori-dialog-in`
    animations; `prefers-reduced-motion` + `.reduce-motion` fallbacks
  - the `max-width:1179px` overlay behaviour
- **CSP is strict**: `style-src 'self'`, `img-src 'self' data:`. No CDN fonts, no
  inline styles. All decoration must be CSS gradients / `clip-path` / SVG data
  URIs inside `styles.css`.
- **No SVG assets exist** in the repo, and no webfonts. Decoration is drawn in
  CSS.
- `AGENTS.md`: run `npm run check` before a completion commit; one commit per
  top-level task; don't commit unsanitized evidence.

## 4. Approach: CSS-only restyle

All work lands in `apps/desktop/renderer/styles.css`. **No changes to
`index.html` or `renderer.js`** — the existing 29 `::before`/`::after` hooks plus
`.star-logo`, `.workspace-avatar`, `.empty-geometry`, `.terminal-circuit`,
`.panel-illustration`, `.page-index` and `.kicker` are enough anchors. This keeps
the DOM-shape assertions in `test:ui` untouched and keeps the diff reviewable.

### 4.1 Add a BA geometry token layer

Extend `:root` (keeping every existing token verbatim) with:

- `--ba-skew: -10deg` and `--ba-unskew: 10deg`
- `--ba-chamfer: 10px` (corner cut size)
- `--ba-hatch`: a `repeating-linear-gradient(45deg, ...)` stripe fill
- `--ba-frame`: hairline border color
- corner-bracket gradient sets for `⌜ ⌝ ⌞ ⌟`

### 4.2 Replace roundness with chamfers

Introduce a `--ba-clip` polygon and apply it to cards, dialogs, composer,
terminal, panel entry buttons and metric tiles, reducing `border-radius` to
near-zero on those surfaces. Keep radius only on genuinely round things
(avatars, status dots, runtime orbs).

### 4.3 Parallelogram action elements

`.new-chat`, `.primary`, `.send-button`, `.terminal-tab`, `.project-branch`,
`.kicker`, settings-nav active item and dialog footer buttons get
`transform: skewX(var(--ba-skew))` with an inner `> *` counter-skew so text
stays upright.

### 4.4 Hatching + technical frames

- 45° hatch behind `.rail-section-header`, `.panel-title`, `.settings-header`,
  the empty-state regions and `.usage-bar` tracks.
- Corner brackets via `::before`/`::after` on `.settings-card`,
  `.project-hero`, `.metric-grid article`, `.work-panel-home button`.
- Crosshair/tick decoration in `.panel-illustration` and `.terminal-circuit`.

### 4.5 Micro-caps annotation

Style `.kicker`, `.page-index`, `.boundary-note` and `.panel-illustration span`
as BA micro-caps: ~10px, `letter-spacing:.18em`, uppercase, low-opacity cyan.
Add annotation text through existing elements only (no new DOM).

### 4.6 Motion

Rework the existing `tsukiori-button-sweep` into a *diagonal* sweep, add a
slight-overshoot slide for `tsukiori-dialog-in`, and keep both behind the
existing `.reduce-motion` / `prefers-reduced-motion` guards that the gate checks.

### 4.7 Fix two real defects found while reading

- `.attention-item` is created in `renderer.js` but has **no CSS rule** — add it.
- `support-<level>` classes (`native-capability support-verified` etc.) are
  unstyled — render them as BA status chips.

## 5. Verification

1. `pnpm test:ui` — must stay 10/10 green (this is the palette/metric gate).
2. `pnpm run check` — checkpoint + secret scan, per `AGENTS.md`.
3. Launch Electron with `--remote-debugging-port` (same technique as
   `scripts/probe-ui-interactions.mjs`) and capture
   `Page.captureScreenshot` for the main workspace and the settings dialog, so
   the restyle is checked visually and not just by assertion.
4. Confirm no CSP violations appear in the renderer console.

## 6. Deliberately out of scope

- The `setting-theme` select persists a `theme` value but `applyAppearance()`
  never applies it, so light/system is currently a **no-op**. The user chose
  "replace current styling", so I will not build a theme switch here. Flagging
  it as a separate pre-existing bug rather than silently fixing it.
- No changes to layout metrics, information architecture, or any behaviour.

# CCC owner UI redesign — design

Date: 2026-11-01 · Owner: Ahmed Shaltoot · Extends: [2026-11-01-ccc-design.md](2026-11-01-ccc-design.md),
[2026-11-01-ccc-projects-design.md](2026-11-01-ccc-projects-design.md)

## 1. Intent

Ahmed keeps CCC open on a **second monitor while working**. He wants to see at a glance which sessions
need him, and to act fast. The current UI works but reads loud and flat: colour bands make idle
sessions as loud as blocked ones, and several elements fail contrast in dark mode.

**Decided (by Ahmed):** a **redesign**, not a polish. **Desktop first** (≥ 1024 px). Phone stays
functional but secondary. Tone: **calm ops console**: neutral surfaces, colour only for status.
Guidance sources: the **UI/UX Pro Max** skill (Data-Dense Dashboard style, priority checklist,
pre-delivery checklist) and **Vercel Web Interface Guidelines**.

**Success:**
1. A blocked or unreachable session is the first thing the eye lands on.
2. Every text pair passes WCAG AA in light and dark.
3. Every gap in §7 is fixed.
4. The existing behaviour and tests are kept.

## 2. Constraints (unchanged invariants)

- Vanilla JS ES modules, DOM built only with `h()`. No `innerHTML`, `outerHTML`,
  `insertAdjacentHTML` or `document.write`. No new runtime or dev dependencies.
- Every UI JS file is ≤ 800 lines. The live-refresh **`hasDraft` guard** still protects half-typed input.
- Server API unchanged. The only server edit is one static route in `src/app.ts`:
  `GET /views/:file{[a-z0-9-]+\.js}` → `public/views/<file>`. It uses the same strict pattern as the existing
  single-segment route, so no `..` or nested paths can reach the file system.
- Light and dark are both first-class, following `prefers-color-scheme`.

## 3. Structure (approach 1: redesign + split)

| File | Owns |
|---|---|
| `public/app.js` | state, `load()/refresh()`, SSE, router, keyboard, shell (sidebar/topbar), `hasDraft`, `liveRefresh` |
| `public/dom.js` | `h`, `mount`, `api`, `confirmButton`, `debounce`, `Unauthorized`, `ago` (now `Intl`-based) |
| `public/logic.js` | pure helpers: `severityRank`, `sortSessions`, `parseRoute`, `formatRoute`, `isTypingTarget`, `relTime` |
| `public/views/board.js` | summary strip, grouped board |
| `public/views/questions.js` | questions page |
| `public/views/tasks.js` | tasks page |
| `public/views/controls.js` | controls page |
| `public/views/detail.js` | session drawer |
| `public/style.css` | rewritten on new tokens |

Views receive `(state, actions)` and return nodes. They do not import `app.js`, which avoids an import cycle.
`logic.js` has no DOM access, so node:test imports it directly. The existing static route matches one
path segment only, so `/views/*.js` needs the new route from §2. Tests check that it serves JavaScript
and returns 404 for `/views/../app.ts`.

## 4. Foundations

**Type.**
- IBM Plex Sans 400/500/600 for UI text, IBM Plex Mono 400/500 for session names, IDs, timers and counts.
- `.mono` and every numeric column use `font-variant-numeric: tabular-nums`.
- Scale: 12 / 13 / 14 / 16 / 20 px. 14 is the dense body size, 16 on phones.
- IBM Plex Sans Condensed is dropped.
- Headings use `text-wrap: balance`.

**Colour tokens** (semantic names, light and dark defined together):
- `--bg`, `--surface`, `--surface-2`, `--border`, `--text`, `--text-muted`, `--accent`, `--on-accent`, `--focus`
- `--st-{working|blocked|unreachable|idle|offline}` (rail/dot/word)
- `--st-blocked-tint`, `--st-unreachable-tint` (row backgrounds)
- `--danger`

Neutral zinc surfaces and one blue accent.

- **Status is shown by a 3 px left rail, a dot and the status word, never by colour alone.**
  Only blocked and unreachable rows get a tinted background.
- Contrast:
  - Every text token is ≥ 4.5:1 on each surface it sits on, including status words on their tint.
  - Rails, borders and the focus ring are ≥ 3:1. The `--border` token is decorative and exempt.
  - Enforced by a test (§8).

**Spacing and shape:** 4 px base scale (4/8/12/16/24/32). 6 px radius. 1 px borders. No shadows
except the drawer and the toast.

**Motion:** 150–200 ms ease-out on `opacity`, `transform`, `background-color` and `border-color` only.
Never `transition: all`. The live dot pulses. Under `prefers-reduced-motion: reduce`, all
transitions and the pulse are disabled.

**Global (Vercel):**
- `<meta name="theme-color">` for light and dark.
- `color-scheme` on `:root`.
- Native `<select>` with an explicit `background-color` and `color`.
- `touch-action: manipulation` on controls.
- `translate="no"` on session, project and device names.
- `:focus-visible` rings (2 px `--focus`, 2 px offset).
- `scroll-margin-top` on headings.
- A skip link to `main`.

## 5. Shell and navigation

**≥ 1024 px:** a sticky 220 px **sidebar**:
1. Brand.
2. Nav (Board, Questions *n open*, Tasks *n open*, Controls), with `aria-current` on the active item.
3. A **Projects** list: All plus each project, with its session count and a blocked marker. This replaces the header `<select>`.
4. At the bottom, the live indicator and a "? Shortcuts" button.

**< 1024 px:** a top bar holding the nav tabs and a project `<select>`. **< 640 px:** rows stack, and
touch targets are ≥ 44 px.

**Login:** a centred card only. The nav, project list and live indicator are not rendered until
authenticated (fixes the empty picker shown on the login page).

**Routing:** the hash reflects state:
- `#/board`, `#/questions`, `#/tasks`, `#/controls`
- the optional query `?project=<name>` and `?status=<status>` (board only)
- `#/session/<name>` opens the drawer over the board.

`parseRoute` treats an unknown view, an invalid project name or a garbage hash as `#/board`. A
project that no longer exists falls back to All, keeping today's stale-project behaviour.
`hashchange` drives rendering, so Back and Forward work. The last project is still saved to
`localStorage`, wrapped in try/catch, and used only when the hash names none.

**Keyboard:** handled on `document`, ignored when `isTypingTarget(event.target)` (input, textarea,
select, contenteditable) or when a modifier other than Shift is held.

| Keys | Action |
|---|---|
| `g` then `b` / `q` / `t` / `c` (within 1 s) | go to view |
| `j` / `k` | next / previous board row (roving focus) |
| `Enter` | open the focused row's drawer |
| `0`–`9` | project: 0 = All, n = nth project in the sidebar |
| `?` | shortcut sheet (a `<dialog>`) |
| `Esc` | close the drawer or sheet; focus returns to the opener |

## 6. Pages

**Board**
- **Summary strip:** a count per status. Each count is a toggle button (`aria-pressed`) that sets `?status=`.
- **Waiting banner** when questions are open: "*n* questions waiting · *m* blocking", with an **Answer** button.
- Rows are about 36 px `<button>`s:
  - Rail, then the name (mono), the status word with its dot, the summary or current task (one line, ellipsis, full text in `title`), and "seen" time right-aligned.
  - Blocked rows add a second line with the blocker or question.
  - Unreachable rows have a second line: "Not responding. Nudge it in its terminal." CCC cannot wake a
    session itself; the agent picks up messages only when its next turn ends.
  - The orchestrator is marked with ★ and `aria-label="orchestrator"`.
- In All, rows are **grouped by project**: each group has a heading with the project name and its orchestrator, and groups are sorted by name.
- Inside a group, rows are sorted by `sortSessions`: blocked < unreachable < working < idle < offline, then by name.
- Empty state: "No sessions yet", plus the launch line `CCC_PROJECT=… CCC_SESSION=… claude`.

**Session drawer**
- A `<dialog>` anchored right, 480 px wide (full width on phones), with `overscroll-behavior: contain`.
- Header: name, status, project chip, ★ when orchestrator, device, last seen.
- Actions: **Pause** / **Resume** and **Message** (with the existing kind select and the "lands when the
  current turn ends" hint).
- Below: the current task, then the event timeline. Each event has `<time datetime title=absolute>` with a relative label.

**Questions**
- Order: blocking first (red rail, "Blocking *name*" tag), then the other open questions, then a collapsed `<details>` "Answered (*n*)".
- Card header: asker (mono) → addressee, project chip in All, `<time>`. The body has `max-width: 72ch`.
- Option buttons send at once, with a 5 s **Undo** toast. The API call is delayed until the toast expires, and Undo cancels it.
- The free-text field has a visible label "Your answer", the helper "⌘/Ctrl+Enter to send" and the placeholder "e.g. use the staging creds in 1Password…". The **Send Answer** button shows "Sending…" while busy.
- The `hasDraft` guard covers this field.
- Empty state: "No open questions. Agents ask here when they're stuck."

**Tasks**
- Filter chips: Open (default) · Done · Cancelled · All.
- A table with columns ID (mono `T12`), Title, Assignee, Project (All only), Status, Updated, and a row `⋯` menu button (`aria-label="Actions for T12"`).
- The menu holds **Reassign** (a session select with **Save**) and **Cancel Task** (`confirmButton`).
- **New task** form above the table:
  - Title, labelled.
  - Details, a labelled textarea that grows when focused.
  - Assign to: in a project, that project's sessions only; in All, `<optgroup>` by project.
  - The **Create Task** button.
- Empty state for each filter.

**Controls:** three `<fieldset>`s with `<legend>`s.
1. **Everyone:**
   - Scope select (All projects / each project).
   - Labelled broadcast textarea.
   - **Send Broadcast** (primary).
   - **Pause All** (`confirmButton`) and **Resume All**.
2. **Sessions:** a table with columns Name, Project, Role, Device, then actions.
   - Role is a select. Move to project is an input with a datalist and the placeholder "Project name…".
   - A row shows **Save** only when one of its fields differs from the stored value.
   - **Retire** is a danger text button with `confirmButton`, separated from the others.
3. **Devices:**
   - Token list.
   - **Add Device** form, with the label "Device label" and the placeholder "e.g. win-box…".
   - A new token shows once in a mono box with **Copy Token** and the warning "Shown once. Store it now."

**Copy, everywhere:** Title Case buttons, `…` for loading text and placeholders, active voice, and errors that say what to do next.
Live connection loss shows "Reconnecting…" on the live indicator. A failed action shows a toast with the server's
message plus a retry hint. Toasts stay `role="status" aria-live="polite"`.

## 7. Findings this must fix

From design-critique:
- Dark white-on-band contrast (2.56 / 3.26 / 2.76).
- Header "Project" label at 2.66.
- Light "Idle" at 3.59.
- Idle sessions as loud as blocked.
- Picker shown on login.
- Cluttered Controls rows, with a placeholder that looked like a value.
- Unlabelled answer field.
- Task controls always visible.
- No grouping by project.

From the Vercel audit:
- No `theme-color`.
- No `tabular-nums`.
- Hand-rolled relative time.
- No `<time datetime>`.
- Placeholders without `…` or an example.
- URL doesn't reflect state.
- No `text-wrap: balance`.
- Native select has no dark colours.
- No `translate="no"`.

## 8. Testing

Test first (RED, then GREEN). Then the full suite and `npm run check`, quoting the pass count.

- **Contrast** (`test/ui-contrast.test.ts`):
  - Parse the light and dark token blocks from `style.css`.
  - Assert the WCAG ratio for each pair listed in a fixed table in the test: text/muted/accent on bg/surface/surface-2, each status word on surface and on its tint, on-accent on accent, focus and rails on surface.
  - Ratio ≥ 4.5 for text, ≥ 3 for non-text.
- **CSS rules** (`test/ui-css.test.ts`):
  - No `transition: all` and no `transition:` without explicit properties.
  - No `outline: none` unless the same file has `:focus-visible`.
  - A `prefers-reduced-motion` block is present.
  - `.mono` sets `tabular-nums`.
  - `meta name="theme-color"` exists in `index.html`.
- **Logic** (`test/ui-logic.test.ts`, imports `public/logic.js`):
  - `sortSessions` order.
  - `parseRoute`/`formatRoute` round-trip, plus garbage → board.
  - `isTypingTarget` for input, textarea, select and contenteditable, using stubs.
  - `relTime` for seconds, minutes, hours and days.
- **Existing UI tests** become recursive over `public/`, so `views/*.js` are covered by the
  no-`innerHTML` and ≤ 800-line checks. The `hasDraft`/`liveRefresh` regexes still match `app.js`.
  `/views/board.js` is served as JavaScript, and `/views/../app.ts` returns 404.
- **Visual check (manual):** scratch Playwright `shoot.mjs`, before and after, for every page at 1280×860 and
  390×844, light and dark. Ahmed reviews the after set before deploy.

## 9. Rollout

Tag the running image as `ccc:pre-redesign`. Merge, push, then `docker compose up -d --build`. Smoke-test
login, board, SSE and an answer. To roll back, retag `ccc:pre-redesign` as `ccc:local` and run `up -d`.

## 10. Non-goals

- Themes beyond light/dark, or a manual theme toggle.
- New API endpoints, new data, or a server-side "nudge": waking a stuck terminal is out of CCC's reach.
  The only server change is the §2 static route.
- Icon fonts or SVG icon sets: the glyphs (dot, ★, ⋯) are text with `aria-label` or `aria-hidden`.
- Drag-and-drop, bulk actions or virtualisation: session counts are tiny.

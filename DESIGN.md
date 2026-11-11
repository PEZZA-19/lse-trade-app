# Design principles

The app should feel as calm and obvious as a good Apple app. These rules apply to every screen.
They follow Apple's Human Interface Guidelines (clarity, deference, depth) and the lessons in
[`docs/REQUIREMENTS_FROM_REVIEWS.md`](docs/REQUIREMENTS_FROM_REVIEWS.md).

## Principles

1. **Clarity.** One job per screen, one obvious primary action (a single filled button). Plain words, no
   jargon: "Mark as sent", "Customer said yes", "Create job", "Allowance" (not "PC sum"), "To do" / "Done".
2. **Deference.** Content first. Chrome is quiet: translucent bars, hairline separators, no heavy borders,
   colour used for meaning (status, the primary action), not decoration.
3. **Depth.** Create and edit happen in **sheets** that slide over the current screen (Cancel left,
   the one action right). Navigation pushes a new page with a back button.
4. **Honesty (from competitor reviews).** Never show something as saved, sent, viewed or paid unless the
   server confirmed it. Every write has a visible state: _Unsaved changes → Saving… → Saved_, or
   _Not saved · Retry_. Edits that work offline say _Saved on this device · will sync_ until the server
   has them, and a sync badge counts what is waiting. A network failure on anything that needs a
   connection says "No connection. Nothing was saved." "Mark as sent" records
   a fact; it does not pretend an email went out. A £0 or empty quote cannot be marked as sent.
5. **Instant feedback, honest outcome.** Optimistic UI is used for display only (e.g. a job's status
   changes immediately). The change is stored on the device first; it rolls back with an error toast
   only if even that fails. Conflicts with another device are never resolved silently when the same
   field changed on both: the Sync screen asks _Keep mine_ or _Use theirs_. Buttons respond on press (scale + colour) and show a spinner while working.
6. **Sensible defaults, minimal typing.** Labour lines default to the business rate (£45/h), materials to
   cost × the usual markup (1.3, or the customer's own), the first site is pre-selected, quantity is 1,
   validity is 30 days. Only the essentials are required (a customer's name; a quote's title).
7. **Fast.** Lists are paged on the server; skeletons appear while loading, previous results stay on
   screen while a search refines; the app shell is cached by the service worker. Budget: first load
   under 150 KB JS gzipped, a list or detail opens in under 1 s on 4G.

## Layout

| Size             | Navigation                               | Content                    |
| ---------------- | ---------------------------------------- | -------------------------- |
| Phone (< 900 px) | Bottom tab bar (Jobs, Quotes, Customers) | Full width, 16 px margins  |
| Tablet / desktop | Left sidebar with the business name      | Centred column, max 760 px |

- Large title (34 pt bold) at the top of every page; back button above it on detail pages.
- Inset grouped lists (rounded 12 px cards on a grey background), section headers in small caps.
- Safe-area insets respected (notch, home indicator) for the installed app.

## Tokens (`apps/web/src/styles/tokens.css`)

Components use variables only, never raw values.

- **Type:** system font stack (`-apple-system`, SF Pro, Segoe UI, Roboto, Inter fallback). Scale follows
  iOS Dynamic Type: large title 34, title1 28, title2 22, title3 20, headline 17 semibold, body 17,
  callout 16, subhead 15, footnote 13, caption 12.
- **Spacing:** 4 pt grid (`--space-1` 4 … `--space-12` 48).
- **Radii:** 8, 10, 12 (cards), 14 (sheets), 16, pill.
- **Colour:** Apple system palette for light and dark mode. Text tints are darkened where needed so every
  text/background pair passes WCAG AA (4.5:1), e.g. accent `#0062cc` in light mode instead of `#007aff`.
- **Motion:** 120 ms (press), 220 ms (page), 380 ms spring (sheets). All durations drop to 0 under
  `prefers-reduced-motion`.
- **Touch:** every tappable thing is at least 44 × 44 pt (`--tap`).

## Components (`apps/web/src/components`)

`Page` (large title, back, actions) · `Section` / `List` / `LinkRow` / `ButtonRow` / `KeyValueRow` ·
`SwipeRow` (trailing actions, also reachable by keyboard) · `Sheet` (modal, focus-trapped, Escape closes) ·
`Button` (primary, secondary, plain, destructive; loading state) · `IconButton` · `Segmented` ·
`SearchField` · `Pill` (status) · `TextField` / `SelectField` / `TextAreaField` · `SaveStatus` ·
`Toast` (with Undo / Retry) · `OfflineBanner` · `EmptyState` · `ListSkeleton` · `.switch` (iOS toggle on a
native checkbox).

## Accessibility

- Real buttons, links, labels and headings; dialogs have `aria-modal` and a title; status changes are
  announced via `role="status"`.
- Visible focus ring on keyboard focus; swipe actions are also normal buttons.
- Light and dark mode follow the system setting.

## Checklist for a new screen

- [ ] Large title, at most one primary button
- [ ] Create/edit in a sheet with Cancel / action
- [ ] Loading skeleton, empty state with a helpful next step, error state with Try again
- [ ] Every write shows an honest save state; failures are visible and retryable
- [ ] Works at 390 × 844 and 1280 × 800, light and dark, with reduced motion
- [ ] Tap targets ≥ 44 pt, contrast ≥ 4.5:1, plain-English labels

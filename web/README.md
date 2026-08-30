# Web app

**The live web app now lives in [`../backend/app/static/`](../backend/app/static/)** and is
served same-origin by FastAPI at `/`. This directory keeps the original
localStorage build as a reference.

## Files

| Path | What it is |
|---|---|
| `../backend/app/static/index.html` | Markup + all styling (carried over unchanged from the legacy build) |
| `../backend/app/static/app.js` | The application — views, review mode, modals, sync loop |
| `../backend/app/static/api-client.js` | Data layer: `Auth`, `Store` (IndexedDB), mutations, `syncNow()` |
| `legacy-localstorage-ui.html` | The original single-file localStorage version. **Reference only** — not served, not wired to the API. |

No build step: `index.html` loads `app.js` as an ES module, which imports
`api-client.js`.

## How the port works

- **Auth gate.** `boot()` checks `isLoggedIn()`. Logged out shows `#authGate`
  (login / signup); logged in reveals `#appShell`. A refresh token that the
  server rejects drops you back to the gate mid-session.
- **One entity shape.** Rows are held in exactly the API's shape — snake_case
  fields, ISO-8601 timestamps — so sync payloads are 1:1 with the server. The
  legacy UI used camelCase and epoch-ms and did arithmetic directly on the
  numbers; `ms()` parses at the point of use instead, so there is only ever one
  spelling of a field.
- **Mutations** go through `upsertItem` / `deleteItem` / `upsertSession`, which
  stamp `updated_at` and mark the row `_dirty`. Then `afterMutation()` re-reads
  the cache, re-renders, and schedules a debounced push.
- **Sync loop.** On load, every 60 s, on `online`, on tab focus, and 1.2 s after
  any edit. Failures are non-fatal: the IndexedDB cache is authoritative and the
  status line reads "offline — changes saved locally".
- **Deletes are tombstones** (`deleted = true`), never row removal, so they
  propagate to other devices.

## Deliberate behaviour changes from the legacy build

- **Restore from backup merges, it no longer replaces.** A destructive replace
  would tombstone rows on every synced device. Items are merged by id, and only
  when the backup copy has a newer `updated_at`.
- **Export downloads a file** via a Blob URL instead of calling the
  artifact-host `window.claude.use("downloads")` bridge, with clipboard and a
  copyable panel as fallbacks.
- **The `[data-close]` handler is delegated.** The legacy build bound it once at
  boot, which left the review "Desk cleared" → *Done* button dead, since that
  card is rendered later.
- **Theme and the default shelf life stay in `localStorage`** as per-device
  preferences. They aren't entities in the data model, so they don't sync.

## Peek — one window, reused

Triage sometimes needs an actual look, not just a preview. **Peek** (on Inbox
cards, and the first action on the review screen) opens the link in a popup
window — and every later peek steers that *same* window instead of opening
another, so working through thirty links costs one window rather than thirty
tabs. The mechanism is the second argument to `window.open`: a named target
makes the browser reuse the window already answering to that name, and the name
outlives a page reload.

**Why not an iframe.** Most of the web refuses to be framed — `X-Frame-Options`
or `frame-ancestors` blocked 8 of 11 sites sampled while building this,
including GitHub, MDN and Hacker News. Worse, the failure is undetectable from
JavaScript: a blocked frame still fires `load`, and same-origin policy hides
what's inside, so the card would show a permanently blank box with no fallback.
A popup is subject to none of that. The server does record an `embeddable` flag
per URL (`docs/API.md`) from headers it already has in hand, so an in-page
iframe can later be used for the minority of sites that permit it.

## Groups (tab sessions)

The Groups view lists synced `tab_sessions`, and supports rename, delete, and
opening the links. **Capturing** a window and **restoring** it into real Chrome
tab groups requires the extension — a web page can't enumerate your tabs or open
a window of them.

## Testing

`../backend/tests/web_e2e.py` drives the whole thing in headless Chromium,
including two browser contexts on one account to prove sync converges. See
`../docs/LOCAL_SETUP.md`.

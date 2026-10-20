# Decisions

Core Sample is a static PWA. This is the architecture for Stages 1–6. Stage 1 implements only what [PLAN.md](PLAN.md) assigns to it. Later stages should extend this shape, not replace it.

## Stack

Vanilla JavaScript ES modules, HTML, and CSS. No framework and no bundler. IndexedDB is the database. The service worker caches the app shell and nothing else.

Markdown is hand-rolled. Checklist taps have to flip a specific `[ ]` / `[x]` in the source, and the renderer and the toggler have to agree on which boxes count. A library would not make that mapping safer.

## Why this shape

The product is one offline client. Later, the page will call `api.github.com` directly. A Cloudflare Worker (Stage 3, not built) exists only because GitHub's device-code endpoints have no CORS. Notes never live in this repo. There is no application server.

## Layout

- `app/` is the site uploaded to GitHub Pages. URLs are relative, so the same files work at `/core-sample/` and at a local `/`.
- `app/js/` keeps parsing, storage, and save policy out of the DOM so `node --test` can import them.
- `test/` holds the tests. `fake-indexeddb` is the only dependency, and it is a devDependency.
- `scripts/render-icons.mjs` regenerates PNGs from `app/icons/icon.svg`.

## Modules

| Module | Role | Stage |
| --- | --- | --- |
| `checklist.js` | Task markers, fence rules, toggle | 1 |
| `markdown.js` | Render, escape, wikilink parse | 1 |
| `preview-tap.js` | What a preview tap may preventDefault | 1 |
| `notes.js` | Titles, paths, wikilink resolution, welcome note, which note to reopen | 1 |
| `db.js` | IndexedDB | 1 |
| `save.js` | Debounced local save and immediate flush | 1 |
| `view.js` | Editor, preview, notes sheet | 1 |
| `main.js` | Boot, keyboard viewport, service worker, persistent storage | 1 |
| GitHub, sync, merge modules | Do not add these until their stage | 3–5 |

## Storage

Database name `core-sample`, version 1.

`files`, keyed by repo-relative path (`Welcome.md`, later `folder/note.md`):

- `path`, `content`, `kind` (`markdown`; later `text` or `binary`), `encoding`, `createdAt`, `updatedAt`

Folders are not records. The tree is the set of paths. Rename and move, when they arrive, change a path instead of updating a second tree.

`meta`, keyed by string. Stage 1 keys: `lastOpened`, `editorMode`.

Later versions add fields and stores. Do not invent a parallel place to keep a note.

- Optional file fields when sync exists: `sha` (last synced blob), `baseSha`, `deleted` (tombstone), `conflict`. Old records stay valid if these are missing.
- An `ops` store for the sync queue (Stage 4). Conflict data stays on the file record (Stage 5) so a note and its conflict cannot drift apart.

Stage 1 does not write sync fields and does not show a sync status. The status line is only local: Saving…, Saved on this device, or a save failure.

## Save policy

The open note in memory is the working copy. IndexedDB is updated 400ms after the last keystroke, and immediately on note switch, checklist toggle, `visibilitychange` to hidden, and `pagehide`.

The flush starts the IndexedDB transaction synchronously so iOS can finish it while the page is suspending. A failed write leaves the text on screen and shows an error. Nothing is deleted to recover. `navigator.storage.persist()` is requested at launch. Clearing Safari website data for this app still erases IndexedDB; the welcome note says so.

Remote sync will use its own 2–5 second debounce. That clock must never be what saves the local copy.

## Markdown and checklists

`checklist.js` owns task parsing and fenced-code rules. The renderer uses those same helpers, so a box inside a code fence is neither a button nor a toggle target.

Toggling replaces one mark character (` ` or `x` / `X`). The string length does not change, so textarea selection offsets stay put. The control is a `button type="button"`. The handler does not focus the textarea, so the keyboard stays down. Preview scroll position is restored after the re-render.

Wikilinks: `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `[[target#heading|alias]]`. A tap resolves against local notes: full path, otherwise a unique filename, case-insensitive. One match opens that note and scrolls to the heading when there is one. No match creates a note with that name and opens it, which is the Obsidian behavior. More than one match does not guess. The control is a `<button type="button" class="wikilink">`, not an `<a href="#...">`. In an installed iOS app a fragment link with no matching id does nothing, and iOS does not reliably treat that tap as an in-app action.

External `http:`, `https:`, and `mailto:` links are plain anchors with `rel="noopener"` and no `target`. The preview click handler does not call `preventDefault` on them. iOS standalone ignores `target="_blank"` and `window.open` (the new browsing context is dropped, so the tap looks dead). A normal navigation is what that WebKit opens in its in-app Safari view. `javascript:` is not linked. Relative markdown links stay inside the app and are resolved like wikilinks, so removing `target="_blank"` cannot navigate the installed app away from itself. Remote images are rendered as their alt text so the preview does not make third-party requests.

## App shell and subpath

Manifest `start_url` and `scope` are `./`, resolved against the manifest URL. On Pages that is `/core-sample/`. The file is `manifest.json` so GitHub Pages serves it as `application/json`, which browsers accept. The service worker is registered as `./sw.js`; its scope is that directory.

Cache name and the visible footer are the same string, `core-sample-shell-v3` (`APP_BUILD` in `app/js/version.js`, `CACHE` in `app/sw.js`). Bump both when a shell file changes. The test fails if they diverge.

The installed app stayed on the old shell because the v1 worker returned cached `index.html` and scripts whenever they were in the cache (`if (cached) return cached` in that worker's `fromCacheOrNetwork`). The open document keeps running the JavaScript it already loaded. v1 never called `registration.update()`, never set `updateViaCache: 'none'`, and had no `controllerchange` reload. iOS standalone also checks for a new `sw.js` less often than a Safari tab. The phone therefore kept executing the cached v1 bundle — the one whose preview still said the target note doesn't exist — after the site was already serving the fix. v2 was still cache-first, so the next bump would stall the same way.

Navigation, `index.html`, `sw.js`, and app JS/CSS are network-first. Those fetches use `cache: 'no-cache'`, so the HTTP cache cannot answer with the previous shell. If the network fails, the worker uses its cache, and a navigation falls back to cached `index.html`. Icons and the manifest stay cache-first. Install precaches with `cache: 'no-cache'`, then `skipWaiting`. Activate deletes older caches, calls `clients.claim()`, then `client.navigate()` so a page still running an older bundle loads this shell. That navigation fires `pagehide`, which flushes the open note.

The page registers with `{ updateViaCache: 'none' }`, calls `registration.update()` on launch and when the document becomes visible, and on `controllerchange` flushes the open note and reloads. The first install does not reload from that listener. If navigating to the current URL is rejected, the worker loads the same page once with `?shell=` set to the build id, and the page removes that query with `history.replaceState` so it does not stick. Auto-reload, not a banner: a banner is easy to miss, and the last failure was a status line that did not get the new code onto the phone.

Cross-origin requests and anything that is not the shell are ignored. Note text is never cached. Removing the Home Screen icon deletes that web app's data on iOS, including IndexedDB notes. Re-adding starts empty. Do that only if a couple of cold opens still show an old build in the footer.

## iPhone layout

`viewport-fit=cover`, translucent status bar, safe-area padding, editor text at 17px so iOS does not zoom on focus. `visualViewport` sets the app box: when the keyboard opens, the editor shrinks instead of sitting underneath it. `interactive-widget=resizes-content` covers browsers that already resize the layout viewport. Light and dark follow `prefers-color-scheme`. The palette is paper, clay, and shale.

## Icons

`app/icons/icon.svg` is the source: an isometric core sample, elliptical top, banded strata, paper-colored beds with ruling lines so the stack reads as notebook pages. PNGs, including the 180×180 apple touch icon, are generated from it. Home-screen icons are opaque; iOS paints transparency black.

## GitHub (later)

Not part of Stage 1. When it arrives: device flow through a Worker that forwards only the two device endpoints and stores no client secret; repo calls from the page to `api.github.com`; tokens in IndexedDB only; one repo and one branch; no force-push. Do not read `caffeinatedjoe/zt_vault` from this repo until that stage, and never commit vault contents.

## Testing

`npm test` runs `node --test`. Persistence tests use `fake-indexeddb` and a unique database name per test. Keyboard, Add to Home Screen, and standalone launch are checked on an iPhone. Desktop checks cover render, toggle, save, and reload.

## Left out of Stage 1

Folders, rename, move, delete, search, import/export, GitHub auth, sync, conflicts, and background sync.

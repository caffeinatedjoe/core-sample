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
- `scripts/render-icons.py` builds the PNGs from `app/icons/source/core-sample-icon-source.jpg`.

## Modules

| Module | Role | Stage |
| --- | --- | --- |
| `checklist.js` | Task markers, fence rules, toggle | 1 |
| `markdown.js` | Render, escape, wikilink parse | 1 |
| `preview-tap.js` | What a preview tap may preventDefault | 1 |
| `notes.js` | Titles, paths, wikilink resolution, welcome note, which note to reopen | 1 |
| `db.js` | IndexedDB | 1 |
| `save.js` | Debounced local save and immediate flush | 1 |
| `view.js` | Editor, preview, notes browser | 1–2 |
| `organize.js` | Rename, move, trash, link updates | 2 |
| `browser.js` | Folder rows, search, recent notes | 2 |
| `backup.js` | Export and import of the local notes | 2 |
| `main.js` | Boot, keyboard viewport, service worker, persistent storage | 1 |
| GitHub, sync, merge modules | Do not add these until their stage | 3–5 |

## Storage

Database name `core-sample`, version 1.

`files`, keyed by repo-relative path (`Welcome.md`, later `folder/note.md`):

- `path`, `content`, `kind` (`markdown`; later `text` or `binary`), `encoding`, `createdAt`, `updatedAt`

Folders are not records. The tree is the set of paths, plus a `folders` meta list so an empty folder can exist before it has a note. Rename and move change paths. They do not copy the note into a second store.

A trashed note stays in `files` with `trashedAt` set. The text is unchanged. Restore clears `trashedAt`. Empty Trash is a separate confirmed action and is the only one that deletes note records. Old records without `trashedAt` are live notes.

`meta`, keyed by string. Keys: `lastOpened`, `editorMode`, `folders`, `recent`, `expanded`.

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

Cache name and the visible footer are the same string, `core-sample-shell-v9` (`APP_BUILD` in `app/js/version.js`, `CACHE` in `app/sw.js`). Bump both when a shell file changes. The test fails if they diverge.

The installed app stayed on the old shell because the v1 worker returned cached `index.html` and scripts whenever they were in the cache (`if (cached) return cached` in that worker's `fromCacheOrNetwork`). The open document keeps running the JavaScript it already loaded. v1 never called `registration.update()`, never set `updateViaCache: 'none'`, and had no `controllerchange` reload. iOS standalone also checks for a new `sw.js` less often than a Safari tab. The phone therefore kept executing the cached v1 bundle — the one whose preview still said the target note doesn't exist — after the site was already serving the fix. v2 was still cache-first, so the next bump would stall the same way.

Navigation, `index.html`, `sw.js`, and app JS/CSS are network-first. Those fetches use `cache: 'no-cache'`, so the HTTP cache cannot answer with the previous shell. If the network fails, the worker uses its cache, and a navigation falls back to cached `index.html`. Icons and the manifest stay cache-first. Install precaches with `cache: 'no-cache'`, then `skipWaiting`. Activate deletes older caches, calls `clients.claim()`, then `client.navigate()` so a page still running an older bundle loads this shell. That navigation fires `pagehide`, which flushes the open note.

The page registers with `{ updateViaCache: 'none' }`, calls `registration.update()` on launch and when the document becomes visible, and on `controllerchange` flushes the open note and reloads. The first install does not reload from that listener. If navigating to the current URL is rejected, the worker loads the same page once with `?shell=` set to the build id, and the page removes that query with `history.replaceState` so it does not stick. Auto-reload, not a banner: a banner is easy to miss, and the last failure was a status line that did not get the new code onto the phone.

Cross-origin requests and anything that is not the shell are ignored. Note text is never cached. Removing the Home Screen icon deletes that web app's data on iOS, including IndexedDB notes. Re-adding starts empty. Do that only if a couple of cold opens still show an old build in the footer.

## iPhone layout

`viewport-fit=cover` and `black-translucent` let the page draw under the status bar, from physical y=0. On a standalone iPhone the layout viewport is shorter than the screen by the status bar: Joe measured innerHeight 797, outerHeight 844, safe-top 47, and `#app` bottom 797. `inset: 0`, `100%`, and `100vh` all follow that short viewport, so the frame stops 47px above the physical bottom. That 47px is not the keyboard. `layoutFrame` in `app/js/viewport.js` sizes `--app-h` from `outerHeight` in standalone (it follows orientation; `screen.width` / `screen.height` do not swap), and from `innerHeight` in a browser tab. The keyboard overlap is `innerHeight - visualViewport.height - offsetTop`, and the frame shrinks from the full height only when that overlap is greater than 80px. Scroll containers fill the frame. Their bottom padding is `var(--safe-bottom)`. Header padding still clears the status bar. The notes sheet stays absolute inside the frame. Tapping the footer build id toggles `#layout-debug`, including `--app-h` and `frame-source`. Light and dark follow `prefers-color-scheme`. The palette is paper, clay, and shale. `theme-color` meta tags match that paper. The manifest colors are the light paper (`#f3eee6`). iOS reads the status-bar style and the splash when the icon is added and does not refresh them later.

## Icons

The icon source is `app/icons/source/core-sample-icon-source.jpg`. `scripts/render-icons.py` crops inside the baked-in rounded border and extends the tile color into the square corners, so the PNGs are opaque and full-bleed. iOS applies its own corner mask. Filenames include `v9` because an existing Home Screen icon is a copy taken at Add to Home Screen, and a new URL only helps the next add. The maskable 512 keeps the cylinder inside the center 80%.

## GitHub (later)

Not part of Stage 1. When it arrives: device flow through a Worker that forwards only the two device endpoints and stores no client secret; repo calls from the page to `api.github.com`; tokens in IndexedDB only; one repo and one branch; no force-push. Do not read `caffeinatedjoe/zt_vault` from this repo until that stage, and never commit vault contents.

## Testing

`npm test` runs `node --test`. Persistence tests use `fake-indexeddb` and a unique database name per test. Keyboard, Add to Home Screen, and standalone launch are checked on an iPhone. Desktop checks cover render, toggle, save, and reload.

## Rename, move, and links

The path is the identity. A rename or move rewrites the path, then rewrites links that resolved to that note. A path-style wikilink (`[[folder/note]]`) is pointed at the new path. A bare wikilink (`[[note]]`) is left alone when the file name is unchanged and still unique. A markdown link is rewritten when the relative path would otherwise break. Aliases and heading fragments in links stay. Links inside fenced or inline code are not touched, and an ambiguous name is not guessed. The open note is flushed before the path change. Note text is otherwise left byte for byte; a rename does not rewrite the first heading. The list, Recent, search, and the editor title show the filename without `.md`. A second line may show a short snippet of the body.

## Browser, search, and backup

The notes sheet is the browser: nested folders, expand and collapse, recent notes, and search across file names and note text. Search skips Trash. Nothing in the browser is a second copy of a note.

Export writes one JSON file (`format: core-sample-backup`, version 1) containing every note, including trashed text, plus folders, the last opened path, the editor mode, and recent paths. Import parses that file or refuses it. Add keeps every note already on the device; a path that already has different text is stored beside it as `Name (imported).md`. Replace is a separate confirmation and is the only import that removes notes. On iPhone the export uses the share sheet when the browser allows a file share, and otherwise a download link with no `target`.

## Left out of Stage 2

GitHub auth, sync, conflicts, and background sync.

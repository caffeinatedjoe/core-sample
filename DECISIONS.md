# Decisions

Core Sample is a static PWA. This is the architecture for Stages 1–6. Stage 1 implements only what [PLAN.md](PLAN.md) assigns to it. Later stages should extend this shape, not replace it.

## Stack

Vanilla JavaScript ES modules, HTML, and CSS. No framework and no bundler. IndexedDB is the database. The service worker caches the app shell and nothing else.

Markdown is hand-rolled. Checklist taps have to flip a specific `[ ]` / `[x]` in the source, and the renderer and the toggler have to agree on which boxes count. A library would not make that mapping safer.

## Why this shape

The product is one offline client. The page calls `api.github.com` directly for repository reads and writes. A Cloudflare Worker exists only because GitHub's device-code endpoints have no CORS. Notes never live in this repo. There is no application server.

## Layout

- `app/` is the site uploaded to GitHub Pages. URLs are relative, so the same files work at `/core-sample/` and at a local `/`.
- `app/js/` keeps parsing, storage, and save policy out of the DOM so `node --test` can import them.
- `test/` holds the tests. `fake-indexeddb` is the only dependency, and it is a devDependency.
- `scripts/render-icons.py` builds the PNGs from `app/icons/source/core-sample-icon-source-v2.jpg`.
- `worker/` is the device-flow relay. GitHub Pages publishes `app/` only. Joe deploys the Worker himself.

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
| `github-redact.js` | Strip tokens from error text | 3 |
| `github-device.js` | Device-code request, poll interval, `slow_down` | 3 |
| `github-api.js` | Repo paths, SHA push and pull, Markdown download plan | 3 |
| `github-store.js` | Token and connection settings in IndexedDB | 3 |
| `github-ui.js` | GitHub sheet, connect, manual push and pull | 3 |
| `main.js` | Boot, keyboard viewport, service worker, persistent storage | 1 |
| Sync queue, conflict merge | Do not add these until their stage | 4–5 |

## Storage

Database name `core-sample`, version 1.

`files`, keyed by repo-relative path (`Welcome.md`, later `folder/note.md`):

- `path`, `content`, `kind` (`markdown`; later `text` or `binary`), `encoding`, `createdAt`, `updatedAt`

Folders are not records. The tree is the set of paths, plus a `folders` meta list so an empty folder can exist before it has a note. Rename and move change paths. They do not copy the note into a second store.

A trashed note stays in `files` with `trashedAt` set. The text is unchanged. Restore clears `trashedAt`. Empty Trash is a separate confirmed action and is the only one that deletes note records. Old records without `trashedAt` are live notes.

`meta`, keyed by string. Keys: `lastOpened`, `editorMode`, `folders`, `recent`, `expanded`, `seeded`, and the GitHub connection keys (`githubToken`, `githubClientId`, `githubRelay`, `githubRepo`, `githubBranch`, `githubRoot`, `githubLogin`).

Later versions add fields and stores. Do not invent a parallel place to keep a note.

- Stage 3 file fields: `remoteSha` (blob SHA from the last successful push or pull) and `dirty` (local edits since that SHA). Old records stay valid if these are missing. A rename clears `remoteSha` because the SHA belonged to the old path.
- Still later: `baseSha`, a deleted tombstone, `conflict`, and an `ops` store for the sync queue (Stage 4). Conflict data stays on the file record (Stage 5).

The editor status line is only local: Saving…, Saved on this device, or a save failure. Push and pull report on their own line. There is no Synced / Syncing / Offline state in this stage.

## Save policy

The open note in memory is the working copy. IndexedDB is updated 400ms after the last keystroke, and immediately on note switch, checklist toggle, `visibilitychange` to hidden, and `pagehide`.

The flush starts the IndexedDB transaction synchronously so iOS can finish it while the page is suspending. A failed write leaves the text on screen and shows an error. Nothing is deleted to recover. `navigator.storage.persist()` is requested at launch. Clearing Safari website data for this app still erases IndexedDB; the welcome note says so.

Remote sync will use its own 2–5 second debounce. That clock must never be what saves the local copy.

## Markdown and checklists

`checklist.js` owns task parsing and fenced-code rules. The renderer uses those same helpers, so a box inside a code fence is neither a button nor a toggle target.

Toggling replaces one mark character (` ` or `x` / `X`). The string length does not change, so textarea selection offsets stay put. Leading spaces and tabs stay byte for byte, including when the same words appear on more than one line: the tap uses the task index, not the text. The control is a `button type="button"`. The handler does not focus the textarea, so the keyboard stays down. Preview scroll position is restored after the re-render.

Nested lists follow the source indent. A tab is four columns, the same step as four spaces. Two spaces is a shallower step, and a tab plus four spaces is one step deeper than the tab alone. A task is a checkbox with no bullet; its text sits beside the box, and a wrapped line stays under the text. Child items are real nested lists, so they indent from that item whether the parent is a task, a bullet, or a number. A line that is only more indented, and not itself an item, stays inside that item. `- ## Heading` is a heading inside the list item, and the tasks under it stay nested there.

Wikilinks: `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `[[target#heading|alias]]`. A tap resolves against local notes: full path, otherwise a unique filename, case-insensitive. One match opens that note and scrolls to the heading when there is one. No match creates a note with that name and opens it, which is the Obsidian behavior. More than one match does not guess. The control is a `<button type="button" class="wikilink">`, not an `<a href="#...">`. In an installed iOS app a fragment link with no matching id does nothing, and iOS does not reliably treat that tap as an in-app action.

External `http:`, `https:`, and `mailto:` links are plain anchors with `rel="noopener"` and no `target`. The preview click handler does not call `preventDefault` on them. iOS standalone ignores `target="_blank"` and `window.open` (the new browsing context is dropped, so the tap looks dead). A normal navigation is what that WebKit opens in its in-app Safari view. `javascript:` is not linked. Relative markdown links stay inside the app and are resolved like wikilinks, so removing `target="_blank"` cannot navigate the installed app away from itself. Remote images are rendered as their alt text so the preview does not make third-party requests.

## App shell and subpath

Manifest `start_url` and `scope` are `./`, resolved against the manifest URL. On Pages that is `/core-sample/`. The file is `manifest.json` so GitHub Pages serves it as `application/json`, which browsers accept. The service worker is registered as `./sw.js`; its scope is that directory.

Cache name and the build id in the header are the same string, `core-sample-shell-v14` (`APP_BUILD` in `app/js/version.js`, `CACHE` in `app/sw.js`). Bump both when a shell file changes. The test fails if they diverge.

The installed app stayed on the old shell because the v1 worker returned cached `index.html` and scripts whenever they were in the cache (`if (cached) return cached` in that worker's `fromCacheOrNetwork`). The open document keeps running the JavaScript it already loaded. v1 never called `registration.update()`, never set `updateViaCache: 'none'`, and had no `controllerchange` reload. iOS standalone also checks for a new `sw.js` less often than a Safari tab. The phone therefore kept executing the cached v1 bundle — the one whose preview still said the target note doesn't exist — after the site was already serving the fix. v2 was still cache-first, so the next bump would stall the same way.

Navigation, `index.html`, `sw.js`, and app JS/CSS are network-first. Those fetches use `cache: 'no-cache'`, so the HTTP cache cannot answer with the previous shell. If the network fails, the worker uses its cache, and a navigation falls back to cached `index.html`. Icons and the manifest stay cache-first. Install precaches with `cache: 'no-cache'`, then `skipWaiting`. Activate deletes older caches, calls `clients.claim()`, then `client.navigate()` so a page still running an older bundle loads this shell. That navigation fires `pagehide`, which flushes the open note.

The page registers with `{ updateViaCache: 'none' }`, calls `registration.update()` on launch and when the document becomes visible, and on `controllerchange` flushes the open note and reloads. The first install does not reload from that listener. If navigating to the current URL is rejected, the worker loads the same page once with `?shell=` set to the build id, and the page removes that query with `history.replaceState` so it does not stick. Auto-reload, not a banner: a banner is easy to miss, and the last failure was a status line that did not get the new code onto the phone.

Cross-origin requests and anything that is not the shell are ignored. Note text is never cached. Removing the Home Screen icon deletes that web app's data on iOS, including IndexedDB notes. Re-adding starts empty. Do that only if a couple of cold opens still show an old build in the header.

## iPhone layout

`viewport-fit=cover` and `black-translucent` let the page draw under the status bar, from physical y=0. On Joe's standalone iPhone, innerHeight, `100%`, `100dvh`, and `100svh` were 797 while outerHeight, screen.height, `100vh`, and `100lvh` were 844. The 47px difference is the top safe inset, not the keyboard. v8 pinned `#app` with `position: fixed` and a JS `--app-h` of 844. The box was that tall, and WebKit still clipped and ignored touches in the bottom 47px, so the footer build id sat off-screen. v10 sizes `html` to `100lvh` only in `display-mode: standalone`, and `body` and `#app` fill that parent with `height: 100%`. html and body are not fixed and do not clip overflow. Scroll stays inside the source, the preview, and the notes list. The keyboard overlap is still `innerHeight - visualViewport.height - offsetTop`, and the shell shrinks from that CSS height only when the overlap is greater than 80px. If innerHeight stays short of the screen, scroll content is padded by `max(safe-bottom, oriented screen − innerHeight)` so the last controls stay inside the touchable area. `screen.width` and `screen.height` do not swap; portrait uses the long side and landscape the short side. A browser tab does not add that gap. The build id is a `position: fixed` control under the status bar, above the notes sheet, and it toggles `#layout-debug`. The overlay shows `100lvh`, `100vh`, `100dvh`, and `100svh` from hidden probes, plus `clientHeight` and the html and body rects. html and body both paint `--bg` in light and dark, so a strip WebKit will not lay out still matches the app. Header padding clears the status bar and the build id. The notes sheet stays absolute inside the frame. Light and dark follow `prefers-color-scheme`. The palette is paper, clay, and shale. `theme-color` meta tags match that paper. The manifest colors are the light paper (`#f3eee6`). iOS reads the status-bar style and the splash when the icon is added and does not refresh them later.

## Icons

The current icon source is `app/icons/source/core-sample-icon-source-v2.jpg`. The first source file stays in that directory. `scripts/render-icons.py` crops inside the light bezel (`x 76..434`, `y 79..437`) and extends each corner's tile-edge color outward, so the PNGs are opaque and full-bleed. iOS applies its own corner mask. Filenames include `v11` because an existing Home Screen icon is a copy taken at Add to Home Screen, and a new URL only helps the next add. The maskable 512 keeps the cylinder inside the center 80%.

## GitHub connection

Stage 3 signs in with GitHub's device flow. The browser cannot call `https://github.com/login/device/code` or `https://github.com/login/oauth/access_token` directly, so `worker/` forwards only those two URLs and only for `https://joecoffey.me`. The Worker has no client secret and does not log the body. `wrangler.toml` has no secrets. Joe deploys it; this repo does not.

The client id and the relay origin are typed into Notes → GitHub. They start empty. The token is written only to IndexedDB. A pending device flow is stored there too (`deviceCode`, `userCode`, `interval`, `expiresAt`) so signing in can resume after iOS suspends or reloads the installed app. The device code is not shown, logged, or put in a URL. The user code is shown on screen. Repo, branch, and notes-root calls go to `api.github.com` with the token in an `Authorization` header, never in the URL.

OAuth Apps have no contents-only scope. `repo` is the smallest scope that can read and write a private repository. `public_repo` cannot see a private repo. The scope does not add `workflow`, `admin`, or `delete_repo`. The app still only lists a tree, reads one file, and creates or updates one file. It does not force-push, and it writes only to the repo and branch saved in Settings.

The intended repository is the private vault named in SPEC.md. The app does not fill that name in. The notes folder defaults to the repo root when the field is blank. Paths on the phone are relative to that folder.

Download stores each Markdown file's blob SHA. If the phone already has notes, the download waits for an explicit choice: keep local notes alongside, or export a backup and then confirm replace. A SHA mismatch on push keeps the phone's copy. Pull of a note with local edits keeps the phone's copy unless the text is already identical. Disconnect deletes the token and the repo, branch, and root settings. It leaves the client id, the relay URL, and the notes. Erase local copy is a separate confirmation and does not remove the token.

Automatic sync, debounce, dirty batching, remote polling, retry, backoff, and the sync status machine are Stage 4. Conflicts are Stage 5. Do not commit vault contents.

## Testing

`npm test` runs `node --test`. Persistence tests use `fake-indexeddb` and a unique database name per test. Keyboard, Add to Home Screen, and standalone launch are checked on an iPhone. Desktop checks cover render, toggle, save, and reload.

## Rename, move, and links

The path is the identity. A rename or move rewrites the path, then rewrites links that resolved to that note. A path-style wikilink (`[[folder/note]]`) is pointed at the new path. A bare wikilink (`[[note]]`) is left alone when the file name is unchanged and still unique. A markdown link is rewritten when the relative path would otherwise break. Aliases and heading fragments in links stay. Links inside fenced or inline code are not touched, and an ambiguous name is not guessed. The open note is flushed before the path change. Note text is otherwise left byte for byte; a rename does not rewrite the first heading. The list, Recent, search, and the editor title show the filename without `.md`. A second line may show a short snippet of the body.

## Browser, search, and backup

The notes sheet is the browser: nested folders, expand and collapse, recent notes, and search across file names and note text. Search skips Trash. Nothing in the browser is a second copy of a note.

Export writes one JSON file (`format: core-sample-backup`, version 1) containing every note, including trashed text, plus folders, the last opened path, the editor mode, and recent paths. Import parses that file or refuses it. Add keeps every note already on the device; a path that already has different text is stored beside it as `Name (imported).md`. Replace is a separate confirmation and is the only import that removes notes. On iPhone the export uses the share sheet when the browser allows a file share, and otherwise a download link with no `target`.

## Left out of Stage 3

Automatic sync, the sync status machine, retry and backoff, and conflict merge.

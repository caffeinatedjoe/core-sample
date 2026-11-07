# Plan

Reliability first, then simplicity. Each stage ends with tests, a short review, and a stop for a person to try it. Do not start the next stage in the same change.

## Stage 1 — Basic PWA

This stage.

- App shell and iPhone layout: safe areas, keyboard, light and dark from the system, earthy palette.
- Web manifest and a service worker that caches the shell so the installed app can launch offline.
- Local editor with source and rendered preview. (core-sample-shell-v30 replaced both with one Live Preview surface, and moved the notes into an Obsidian-style sidebar with a separate Settings screen. v31 aligned the sidebar and Settings to Obsidian. v32 puts Search at the top of the sidebar, adds the format toolbar above the keyboard, and continues lists on Enter. v33 pins that toolbar to the visual viewport's bottom and turns the sync flag into a 44pt attention dot. See [docs/live-preview.md](docs/live-preview.md).)
- IndexedDB. Save as you type (debounced) and flush when the page hides. Request persistent storage.
- Create a note, open a note, restore the last opened note.
- Checklist taps in the preview update the source without moving the cursor or opening the keyboard.
- Wikilinks between notes that already exist on the device.
- App icon: isometric core sample, strata that read as stacked pages. SVG plus the PNG sizes iOS needs, including 180×180.
- Tests for render, checklist toggle, wikilink parsing, and persistence across a reopened database.
- GitHub Actions: test, then deploy `app/` to Pages.

Not in this stage: folders, rename, move, delete, search, import/export, GitHub login, sync.

Stop here so Joe can install it on his iPhone.

## Stage 2 — Notes on the device

- File browser built from paths: nested folders, expand and collapse, one-tap open, back to the current note.
- New folder, rename, move, delete. Confirm before a destructive action.
- Search by filename and by content, offline.
- Recent notes.
- Import, export, and backup of the local database.
- Still no GitHub.

## Stage 3 — GitHub connection

Implemented as manual connect, download, and one-file push and pull. Stage 4's debounce, remote polling, retry, and status machine are not part of this.

- Cloudflare Worker that forwards only the device-code and token endpoints. No client secret. No token logging. Allowlist those endpoints and the app origin.
- Checklist for Joe: free Cloudflare account, GitHub OAuth app with device flow, Worker deploy.
- Device flow from the PWA. Token stays in IndexedDB.
- A device code is polled for its token once. The token and the end of the pending flow are one write. A `/user` 401 is rechecked before Sign in again, and the last sign-in failure is shown in the sheet (core-sample-shell-v29).
- Choose repo, branch, and notes root (default: repo root).
- Initial download. Store each file's blob SHA.
- Basic push and pull of one file at a time.
- Repo API calls go straight to `api.github.com`.
- Disconnect GitHub without deleting notes. A separate confirmed action erases the local copy.

## Stage 4 — Automatic sync

Implemented in core-sample-shell-v23. Conflict resolution is Stage 5.

- Separate the local-save clock (Stage 1) from a 2–5 second sync debounce.
- Mark notes dirty. Batch a few edits into one commit. Check the remote before writing.
- While the app is open, look for remote changes about every 60 seconds, and also on foreground, network return, and page hide.
- Do not promise background sync on iOS. Reconcile on the next launch.
- Retry with backoff. Respect rate limits.
- Status: Synced, Syncing, Offline, Changes pending, Conflict, Authentication required, Sync failed. Never show Synced until the remote write has succeeded.
- A failed push keeps the local note and the pending operation.

## Stage 5 — Conflicts

Implemented in core-sample-shell-v25. Vault safety fixes for Welcome uploads, trash restore, rename ghosts, and leftover conflict copies shipped in core-sample-shell-v26. Exact conflict-copy matching, GitHub text for pre-v26 conflicts, the empty-save guard, ancestry-based remote deletes, and an undo toast that no longer covers rows shipped in core-sample-shell-v27. Coexisting with Obsidian Git on a computer (race retries rebuilt on the new head, dot-folders left alone, merge-safe deletes), a busy Resolve button, a 15 second limit on loading GitHub's text, and an honest offline state for pre-v26 conflicts shipped in core-sample-shell-v28. The screen is described in [docs/conflict-ui.md](docs/conflict-ui.md).

- Keep base, local, and remote. Three-way merge.
- Local-only pushes. Remote-only pulls. Non-overlapping edits auto-merge. Identical edits collapse.
- Overlapping edits keep both sides (markers or a conflict copy). A screen to inspect and resolve.
- Stale SHA: refresh, merge on the new head, and retry a limited number of times with backoff; then stay pending and retry later. A race alone is never an error or a conflict.
- Never overwrite a local change that the remote did not include.

## Stage 6 — Polish

- Pass the spec's "done when" list on a real iPhone: install, keyboard, persistence, foreground sync, recovery after suspend.
- Offline tests filled in for the sync queue.
- Docs: install, GitHub auth, troubleshooting, and a clear warning that clearing Safari website data deletes local notes.
- Confirm the only server is the free relay, and that no tokens or notes were committed.

## v34 — Dataview TASK queries

Implemented as core-sample-shell-v34. A ` ```dataview ` TASK block in Live Preview is a read-only widget while the caret is outside it, and the raw query while the caret is inside. Checking a result toggles that line in its source note through the existing save path. The query note's text is never rewritten by rendering.

- Task index from IndexedDB, then incremental updates for local edits, sync, deletes, and renames.
- DQL subset: TASK, FROM (folder, #tag, and/or), WHERE (completed, contains, file fields, ==/!=, &&/||/!), SORT, GROUP BY file, LIMIT. Anything else shows the raw block plus "Not supported in Core Sample yet".
- No network at query time. No tokens, no vault contents in tests.

## v35 — Attachments

Implemented as core-sample-shell-v35, with the rename/sync fix in core-sample-shell-v35.1 and the sign-in token race fix plus diagnostics in core-sample-shell-v35.2. See [docs/attachments.md](docs/attachments.md).

- Sidebar lists non-Markdown files from the GitHub tree (`kind: 'binary'` stubs, no byte download at startup). Images open the existing viewer; other types show name, size, and "Can't preview this file type".
- Bytes are fetched on first view or embed render and cached in the `images` store.
- Live Preview still draws `![[name.png]]` / `![[name.png|300]]` / `![](relative/path.png)`. Wikilink resolution is exact path, unique basename, then closest to the note.
- Paste and the format-bar Image picker write original bytes locally, insert a shortest `![[filename]]`, and upload through the Git Data blob API as base64. Paths follow Custom Attachment Location v0.0.9 defaults. Note rename also renames `assets/<basename>/` when that folder exists. Unchanged attachment moves reuse the existing GitHub blob sha; one unresolvable binary does not hold the rest of the commit.
- Attachment Manager is ignored. Core Sample does not write `app.json`.

## v36 — Live Preview richness

Implemented as core-sample-shell-v36. See [docs/live-preview.md](docs/live-preview.md).

- GFM pipe tables render as a table; tap a cell to edit it. Untouched cells and the delimiter row stay byte for byte.
- `> [!type]` / `> [!type] Title` callouts render as a block; the source comes back when the caret is in the quote.
- `$…$` and `$$…$$` render as MathML from a small offline TeX subset.
- `![[Note]]`, `![[Note#Heading]]`, and `![[Note#^block]]` embed the other note in a box. Images still use `embeds.js`.
- Frontmatter is a Properties panel. Editing one key rewrites only that value.
- A few fence languages get token colors. Unknown languages stay plain.
- Heading sections fold. The folded set is stored in IndexedDB `editorFolds` for that path.

## v37 — Untitled new note

Implemented as core-sample-shell-v37. The sidebar new-document control creates a blank note immediately, the way Obsidian names unsaved files.

- Basename is the first free name in `Untitled`, `Untitled 1`, `Untitled 2`, … (space before the number; gaps filled; case-sensitive path match against local files and the saved vault index).
- File content is exactly `""`. No heading, frontmatter, or starter line.
- The note is written through the existing create/save/sync path (`dirty`, `origin: 'user'`), then opened with the editor focused and the drawer closed.
- Top-left new note lands in the vault root. A folder row's New note still creates in that folder.

## v38 — Strikethrough through nested links

Implemented as core-sample-shell-v38. Live Preview `~~…~~` also paints nested link and wikilink widgets, so struck link text shows `text-decoration: line-through` the way Obsidian and GFM do. Source stays byte-identical.

## v39 — Rename from the note title

Implemented as core-sample-shell-v39. Tapping the open note's title edits the file name in place, through the same rename as the sidebar. Empty, unchanged, and Escape restore the title. A collision or a rejected character keeps the field and shows the existing rename error.

## Priority when a stage gets crowded

If a change adds a second place to store a note, or a second way to sync, cut it back. Data safety beats a smoother-looking screen.

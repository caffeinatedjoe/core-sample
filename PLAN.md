# Plan

Reliability first, then simplicity. Each stage ends with tests, a short review, and a stop for a person to try it. Do not start the next stage in the same change.

## Stage 1 — Basic PWA

This stage.

- App shell and iPhone layout: safe areas, keyboard, light and dark from the system, earthy palette.
- Web manifest and a service worker that caches the shell so the installed app can launch offline.
- Local editor with source and rendered preview.
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
- Choose repo, branch, and notes root (default: repo root).
- Initial download. Store each file's blob SHA.
- Basic push and pull of one file at a time.
- Repo API calls go straight to `api.github.com`.
- Disconnect GitHub without deleting notes. A separate confirmed action erases the local copy.

## Stage 4 — Automatic sync

- Separate the local-save clock (Stage 1) from a 2–5 second sync debounce.
- Mark notes dirty. Batch a few edits into one commit. Check the remote before writing.
- While the app is open, look for remote changes about every 60 seconds, and also on foreground, network return, and page hide.
- Do not promise background sync on iOS. Reconcile on the next launch.
- Retry with backoff. Respect rate limits.
- Status: Synced, Syncing, Offline, Changes pending, Conflict, Authentication required, Sync failed. Never show Synced until the remote write has succeeded.
- A failed push keeps the local note and the pending operation.

## Stage 5 — Conflicts

- Keep base, local, and remote. Three-way merge.
- Local-only pushes. Remote-only pulls. Non-overlapping edits auto-merge. Identical edits collapse.
- Overlapping edits keep both sides (markers or a conflict copy). A screen to inspect and resolve.
- Stale SHA: refresh and retry a limited number of times, then show the error.
- Never overwrite a local change that the remote did not include.

## Stage 6 — Polish

- Pass the spec's "done when" list on a real iPhone: install, keyboard, persistence, foreground sync, recovery after suspend.
- Offline tests filled in for the sync queue.
- Docs: install, GitHub auth, troubleshooting, and a clear warning that clearing Safari website data deletes local notes.
- Confirm the only server is the free relay, and that no tokens or notes were committed.

## Priority when a stage gets crowded

If a change adds a second place to store a note, or a second way to sync, cut it back. Data safety beats a smoother-looking screen.

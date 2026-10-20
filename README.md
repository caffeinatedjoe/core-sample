# Core Sample

An iPhone-first, local-first Markdown notes app. Stage 1 runs entirely on the phone: notes are stored in IndexedDB, and the installed app can open with no network. GitHub sync is not built yet.

The app is served from [https://joecoffey.me/core-sample/](https://joecoffey.me/core-sample/).

## Stage 1

- Home-screen install (manifest, icons, service worker for the app shell only).
- Source and preview editor. Light and dark follow the system.
- Notes save as you type. The last opened note comes back after a reload.
- Create and open notes. `[[wikilinks]]` open a local note, or create it if it is not there yet. Web links open outside the app.
- Tap a checklist in Preview and the Markdown updates in place.
- Folders, rename, move, and Trash. Search by name or text. Export and import a backup of this device.

GitHub login is a later stage. See [PLAN.md](PLAN.md) and [DECISIONS.md](DECISIONS.md).

## Develop

```bash
npm install
npm test
python3 -m http.server -d app 8080
```

Open `http://127.0.0.1:8080/`. Asset URLs are relative, so the same files work at `/` locally and at `/core-sample/` on GitHub Pages.

Icons are built from `app/icons/source/core-sample-icon-source-v2.jpg`. After replacing that file, run `npm run icons` (needs Pillow) and commit the PNGs.

## Install on an iPhone

1. Open https://joecoffey.me/core-sample/ in Safari.
2. Share → Add to Home Screen.
3. Open Core Sample from the home screen. It should launch without Safari's toolbar.

Notes live in this install. The line under the status bar is the shell build. Removing the Home Screen icon deletes that web app's data on iOS, including these notes. Clearing website data does the same. There is no account and no sync in this stage. iOS keeps the Home Screen icon from the moment you add it, so a new icon means export a backup, remove the icon, and add it again. Import with Add to this device brings the notes, folders, and Trash back.

# Core Sample

An iPhone-first, local-first Markdown notes app. Stage 1 runs entirely on the phone: notes are stored in IndexedDB, and the installed app can open with no network. GitHub sync is not built yet.

The app is served from [https://joecoffey.me/core-sample/](https://joecoffey.me/core-sample/).

## Stage 1

- Home-screen install (manifest, icons, service worker for the app shell only).
- Source and preview editor. Light and dark follow the system.
- Notes save as you type. The last opened note comes back after a reload.
- Create and open notes. `[[wikilinks]]` open another note already on the device.
- Tap a checklist in Preview and the Markdown updates in place.

Folders, rename, delete, search, and GitHub login are later stages. See [PLAN.md](PLAN.md) and [DECISIONS.md](DECISIONS.md).

## Develop

```bash
npm install
npm test
python3 -m http.server -d app 8080
```

Open `http://127.0.0.1:8080/`. Asset URLs are relative, so the same files work at `/` locally and at `/core-sample/` on GitHub Pages.

Icons come from `app/icons/icon.svg`. After editing it, run `npm run icons` and commit the PNGs.

## Install on an iPhone

1. Open https://joecoffey.me/core-sample/ in Safari.
2. Share → Add to Home Screen.
3. Open Core Sample from the home screen. It should launch without Safari's toolbar.

Notes live in this install. Clearing Safari website data for the site deletes them. There is no account and no sync in this stage.

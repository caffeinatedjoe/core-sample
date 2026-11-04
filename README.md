# Core Sample

An iPhone-first, local-first Markdown notes app. Notes are stored in IndexedDB, and the installed app can open with no network. GitHub sign-in and download are manual. After a repo and branch are saved, edits sync on their own.

The app is served from [https://joecoffey.me/core-sample/](https://joecoffey.me/core-sample/).

## Stage 1

- Home-screen install (manifest, icons, service worker for the app shell only).
- One Live Preview editor, as in Obsidian: Markdown renders as you type, and the syntax shows only where the caret is. Light and dark follow the system.
- Notes save as you type. The last opened note comes back after a reload.
- Create and open notes. `[[wikilinks]]` open a local note, or create it if it is not there yet. Web links open outside the app.
- Tap a checkbox and the Markdown updates in place, without raising the keyboard.
- `TASK` Dataview queries render as a grouped task list. Checking a result updates the source note.
- A left sidebar like Obsidian's (panel button, or swipe from the left edge): folders, rename, move, and Trash, and search by name or text. The gear opens Settings: GitHub, sync, backup export and import, and the build id.

## GitHub

Settings → GitHub (the gear at the bottom of the sidebar) stores a client id and a relay URL on this phone. Both start empty. The steps to create the Cloudflare Worker and the GitHub OAuth app are in [worker/README.md](worker/README.md) and [DECISIONS.md](DECISIONS.md). The token stays in IndexedDB. Repository calls go to `api.github.com`. Disconnect leaves notes on the phone. After a repo and branch are saved, edits sync on their own. Sign-in, download, and pull also save the images embedded in those notes onto this phone. A saved image opens with no network. When GitHub turns the token down, Settings shows the last sign-in problem: when it happened, which call, the HTTP status, and GitHub's words. It never shows the token.

## Develop

```bash
npm install
npm test
npm run test:vault-pass
python3 -m http.server -d app 8080
```

`npm run test:vault-pass` is the scripted stand-in for a live vault pass: a fake GitHub serving `test/fixtures/vault/`, plus a few iPhone-viewport WebKit taps. It talks to 127.0.0.1 only. CI prints the pass/fail table on every push.

Open `http://127.0.0.1:8080/`. Asset URLs are relative, so the same files work at `/` locally and at `/core-sample/` on GitHub Pages.

Icons are built from `app/icons/source/core-sample-icon-source-v2.jpg`. After replacing that file, run `npm run icons` (needs Pillow) and commit the PNGs.

## Install on an iPhone

1. Open https://joecoffey.me/core-sample/ in Safari.
2. Share → Add to Home Screen.
3. Open Core Sample from the home screen. It should launch without Safari's toolbar.

Notes live in this install. Settings → About shows the shell build. After an update, check that build id and reload Core Sample from the home screen. Removing the Home Screen icon deletes that web app's data on iOS, including these notes. Clearing website data does the same. Export a backup before you ever remove the icon. Import with Add to this device brings the notes, folders, and Trash back.

# v35 Attachments

Plan written after reading `SPEC.md`, `DECISIONS.md`, `PLAN.md`, the sync/storage modules, and Custom Attachment Location **v0.0.9** `main.ts` (tag `0.0.9` on `RainCat1998/obsidian-custom-attachment-location`). Attachment Manager (`chenfeicqq/obsidian-attachment-manager`, community id `attachment-manager`) is enabled in Joe's vault but ignored: it is desktop-only, defaults to `${filename}_Attachments` beside the note, and the vault has zero `_Attachments` folders.

## Root cause

Attachments are missing from the sidebar because they are **never stored as files**, not because a list filter hides them after download.

- `selectMarkdown` / `collectDownload` skip every blob whose path does not end in `.md`. Incremental sync uses the same filter.
- `listBrowser` / `liveNotes` only walk IndexedDB rows with `kind: 'markdown'`.
- The GitHub tree is already fetched. `githubVaultIndex` already lists every non-dot blob (notes and attachments) for embed lookup and the footer count. Bytes for images already lazy-load into the `images` store on first view. None of that feeds the folder tree.

So the vault's `assets/` folders look empty of files: the tree has no rows for png/gif/jpg.

## What already works

Live Preview already draws `![[name.png]]`, `![[name.png|300]]`, and `![](relative/path.png)` via `embeds.js` + `images.js`. Saved note text stays byte-identical. The full-screen image viewer exists. Do not add attachment bytes to the Markdown download; keep that lazy.

## Plugin rules (from v0.0.9 `main.ts`)

Defaults (no `data.json`): `attachmentFolderPath: "./assets/${filename}"`, `pastedImageFileName: "image-${date}"`, `dateTimeFormat: "YYYYMMDDHHmmssSSS"`, `autoRenameFolder: true`, `autoRenameFiles: false`.

- `${filename}` is the note basename without `.md`. Spaces, accents, and punctuation stay.
- `./` is relative to the **note's parent folder** (`Path.join(mdFolderPath, interpolatedPath)`), then Obsidian `normalizePath`. A vault-root note (`dirname` is `.`) lands in `assets/<basename>/`. A note in `Meetings/` would land in `Meetings/assets/<basename>/`. Joe's examples are vault-root notes under `assets/<basename>/`. Core Sample follows the plugin code, not a vault-root override, and does **not** write `.obsidian/app.json`.
- Paste of `image/png` or `image/jpeg` is renamed with `image-${date}` (local time, 17-digit moment stamp). Drop does **not** rename; original names stay. The iOS photo picker uses paste naming because iOS names files `image.jpg`.
- Plugin paste writes extension `jpeg` for `image/jpeg`. Core Sample uses `jpg` for jpeg (and gif/webp/heic as-is) to match the files already in the vault. Noted as a difference.
- The inserted link is Obsidian `generateMarkdownLink`. With no `newLinkFormat` / `useMarkdownLinks`, that is a shortest wikilink: `![[image-….png]]` when the basename is unique.
- Collision suffix is Obsidian's `" 1"` before the extension.
- On note rename, if `autoRenameFolder` and the old attachment folder exists, rename that folder. Links stay valid because they are bare filenames. Core Sample already has note rename, so it will move `assets/<old basename>/` when that folder exists.

## Implementation

1. **Index, don't download.** From the recursive tree already fetched on download and each sync, write `kind: 'binary'` stubs (path, sha, size; empty `content`) for non-`.md` blobs. Never fetch those bytes during startup download. Merge stubs with `githubVaultIndex` so the sidebar lists attachments even on a v34 profile that already downloaded Markdown.
2. **Sidebar.** Folder tree lists non-`.md` files with a type icon and the full filename (extension kept). Tap an image: existing full-screen viewer (fit-to-screen). Tap anything else: name, size, "Can't preview this file type". No editor. Lazy-fetch bytes into the `images` store on first view.
3. **Embed resolution.** Exact vault path, then unique basename. When several files share the basename, the note's `./assets/${filename}` folder wins, then the closest path (fewest directory hops). Missing file: small placeholder. Caret on the line still reveals the raw text.
4. **Insert.** Image button on the format bar (next to Link) opens `<input type=file accept="image/*">`. Paste of an image into the editor uses the same path/name rules. Write bytes locally first, insert the shortest unique `![[…]]`, upload through the Git Data blob API as `encoding: "base64"` (original bytes, no re-encode). Same dirty/conflict/backup path as notes. Offline insert stays queued.
5. **Rename.** When a note is renamed, also rename its attachment folder if that folder exists. Do not rewrite embed links.
6. **Safety.** Never delete or rewrite existing vault attachments except an explicit user trash. Trees still use `base_tree`. No `app.json` writes. No tokens in URLs, logs, or errors. Tests use made-up names only.

Build id: `core-sample-shell-v35`.

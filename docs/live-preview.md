# Live Preview

Core Sample v30 replaces the Source and Preview toggle with one editing
surface that renders Markdown in place, the way Obsidian's Live Preview does.
This page records how Obsidian behaves on mobile and how each behavior maps to
Core Sample.

## How Obsidian does it

Obsidian's editor is CodeMirror 6. The note is always plain Markdown text.
Live Preview changes only what is drawn: a view plugin walks the Markdown
syntax tree for the visible part of the note and adds decorations. Mark
decorations style text (bold, headings, links). Replace decorations hide
syntax characters or swap a range for a widget (bullets, checkboxes, images,
rules). Where the selection is, the syntax comes back as raw text so it can
be edited. Nothing is rewritten, so undo, copy and the saved file are the raw
Markdown.

Obsidian has three views: Reading, Live Preview and Source mode. Live Preview
is the default editing mode, and the help says it "can eliminate the need to
switch to Reading view".

### What is revealed, and how much

| Construct | Rendered as | Raw syntax comes back when |
| --- | --- | --- |
| `#` heading marks | Larger, bold line; marks hidden | the cursor is on that line (per line) |
| `**bold**`, `*italic*`, `_italic_`, `~~strike~~`, `` `code` `` | Styled text; markers hidden | the selection touches that span (per span) |
| `[text](url)` | Link text only | the selection touches that link (per span) |
| `[[note]]`, `[[note\|alias]]` | Link text or alias | the selection touches that link (per span) |
| `-`, `*`, `+` list markers | A bullet | the selection touches the marker; the bullet stays while typing on the line |
| `1.` ordered markers | Left as text, muted | never hidden |
| `- [ ]`, `- [x]` tasks | A tappable checkbox | the selection touches the marker |
| `>` quotes | A left bar; `>` hidden | the cursor is on that line (per line) |
| `> [!note]` callouts | A styled block with a title | Obsidian swaps the whole callout for a widget until the cursor enters it (per block) |
| `---` rule | A horizontal line | the cursor is on that line |
| Fenced code | A shaded monospace block; fences hidden | the cursor is anywhere in the block (per block) |
| Tables | A rendered table you can edit cell by cell | Obsidian has a table editor (per block) |
| `![[image]]`, `![](path)` | The image, inline | the cursor is on that line; the source shows above the image |
| Frontmatter | A Properties panel | Obsidian's Properties editor; a setting shows it as source |

When the editor is not focused (keyboard down, just reading), nothing is
active, so the whole note is rendered.

### Taps

- A tap on rendered text places the cursor there and opens the keyboard.
- A tap on a link opens it, internal or external. Tap and hold places the
  cursor in the link to edit it (and since 1.9.10 on iOS, shows the context
  menu). A link can also be edited by moving the cursor into it from beside it.
- A tap on a checkbox toggles it without moving the cursor or opening the
  keyboard.
- A tap on an image opens the full-screen image viewer. Editing an image link
  on a phone means placing the cursor beside it. This is a known complaint on
  the Obsidian forum.

### Images and embeds

`![[photo.png]]`, `![[photo.png|300]]` and `![alt](path)` render as images
in the line. Note embeds (`![[note]]`) render the other note in a box. While
the cursor is on the line the source shows and the image stays below it, so
the page does not jump.

### Frontmatter and code

Frontmatter shows as a Properties table at the top of the note. Fenced code is
a shaded block with syntax colors. The fences and the language are hidden
until the cursor enters the block.

### Keyboard, selection and scrolling on iOS

- The editor is a native `contenteditable`, so iOS draws the caret, the
  selection handles, the loupe and the copy, paste and look-up menu itself.
- Copy takes the raw Markdown of the selection.
- The app resizes as the keyboard opens and closes (smoother since 1.9.10).
  The line being typed is kept above the keyboard.
- Only the visible part of a long note is drawn. CodeMirror keeps the rest as
  estimated heights, so a note of thousands of lines scrolls smoothly.
- Two-finger swipe gestures are turned off while the keyboard is up, so iOS's
  two-finger cursor movement still works.

### Mobile toolbar

When editing, a scrollable row of actions sits above the keyboard. By default
it starts with undo and redo, then actions such as indent, outdent, checklist,
bold, internal link and tag. It can be reordered and extended with any
command. Toggle keyboard hides the keyboard and swaps the toolbar for the
navigation bar.

## How Core Sample maps it

- **One surface.** The Source and Preview buttons and the `editorMode`
  setting are gone. The old setting is deleted on launch, and backups no
  longer carry it. There is no separate reading view. With the keyboard down
  the whole note is rendered, which is what Obsidian's Reading view adds on a
  phone.
- **Engine.** The editor is CodeMirror 6 (`@codemirror/view`, `state`,
  `language`, `commands`) with `@lezer/markdown` and its GFM extensions. These
  are bundled once into `app/vendor/codemirror.js` and cached by the service
  worker, with no CDN. `@codemirror/lang-markdown` is not used: it pulls in
  the HTML, CSS and JavaScript languages for nested code. Core Sample only
  needs the Markdown parser that it wraps.
- **Reveal rules.** These follow the table above. Headings, quotes and rules
  reveal per line. Inline formatting and links reveal per span. Code fences
  reveal per block. Bullets and checkboxes stay rendered unless the selection
  touches the marker. The rules are in `app/js/live-rules.js`, which builds a
  plain list of decorations from the editor state and is unit tested without
  a DOM.
- **Taps.** Links, wiki-links, checkboxes and images are small non-editable
  islands. A tap on one is handled on `touchend` with `preventDefault` (on
  `click` with a mouse), so the caret does not move and the keyboard stays
  down. A long press puts the caret inside it to edit the syntax, as in
  Obsidian. A tap anywhere else places the cursor. Links and images reuse `preview-tap.js`. Internal links
  go through the same wiki-link rules as before. External links open in the
  browser, and `javascript:` URLs get no link.
- **Images.** `![[image]]` and `![](path)` use the same `embeds.js` and
  `images.js` resolution, IndexedDB copies and offline messages as the old
  preview. A tap opens `image-viewer.js`. While the cursor is on the line, the
  source shows and the image stays below it.
- **Tasks.** A checkbox tap flips the one mark character with the
  `checklist.js` parser. It changes the text in place, keeps the selection,
  saves at once, and does not focus the editor.
- **Dataview TASK queries.** A closed ` ```dataview ` block is a read-only
  widget while the caret is outside it: matching vault tasks, grouped by
  source note. Moving the caret into the block shows the raw query, the
  same as other fences. The widget re-runs when the note is opened and
  whenever the task index changes. Conflict copies, backup copies, and
  other leftover local copies are not indexed. Tapping a result checkbox toggles only
  that status character in the source note (CRLF, tabs, and trailing
  spaces stay) and queues sync through the existing save path. If the
  source line no longer matches, Core Sample relocates by task text or
  refuses; it never writes a different line. Tapping the task text opens
  the source note at that line. Rendering never edits the query note.
  LIST, TABLE, CALENDAR, dataviewjs, and unknown functions stay as the
  raw block plus "Not supported in Core Sample yet".
- **Tables.** A GFM pipe table is a real `<table>` while the caret is
  outside it. Tap or click a cell to edit that cell. A shorter value is
  padded so later pipes on that row stay put; a longer value moves only
  the rest of that row. The delimiter row and every other cell are left
  alone. Long-press the table to put the caret in the source.
- **Callouts.** `> [!note]`, `> [!warning] Title`, and the usual
  Obsidian types (`tip`, `info`, `danger`, …) become a titled block.
  `+` / `-` after the type folds the body in the widget and writes that
  mark back. The raw quote comes back when the caret is anywhere in the
  block.
- **Math.** `$x^2$` and `$$…$$` become MathML. Safari paints MathML, so
  there is no KaTeX bundle, no fonts, and no CDN. The subset is
  fractions, scripts, roots, Greek, a short operator list, and
  `\text` / `\mathrm` / `\mathbf`. Anything else stays as the original
  TeX in a muted span. `$10` is money, not math.
- **Note embeds.** `![[Note]]`, `![[Note#Heading]]`, and
  `![[Note#^block]]` draw the other note in a box. Image embeds
  (`![[photo.png]]`) are unchanged. A missing note says "Note not on
  this phone". More than one match, a self-embed, or a missing heading
  or block is also named. The box is capped at 4,000 characters and
  does not nest another note embed. Tap the title to open the note.
- **Properties.** Closed `---` frontmatter is a Properties panel. Tap a
  value to edit it, or tap a boolean. Only that value is rewritten;
  key order, comments, and untouched lines stay. With the caret in the
  YAML the source is still there for anything the panel does not model
  (multiline `|` blocks stay raw).
- **Fence colors.** js/ts, json, python, css, html/xml, bash, yaml,
  markdown, and sql get keyword / string / comment / number marks. No
  extra language packs. Other info strings stay plain monospace.
- **Heading fold.** A chevron on a heading with a body folds through
  the next same-or-higher heading. Folded keys live in IndexedDB meta
  `editorFolds` as `{ "Note.md": { "h2:plan": true } }`, the same
  local-meta pattern as expanded folders. A caret inside a folded
  section unfolds it for that moment so the line can be edited.
- **Text on disk.** CodeMirror splits lines only on `\n`, so `\r\n` endings,
  tabs and trailing spaces come back exactly as typed. Rendering never edits
  the text. The 400 ms save, flush on hide, sync and conflicts read the same
  string as before.
- **Layout.** A heading line has the same size with the cursor on or off it.
  Only the hidden marks reflow. Images keep their place while their source is
  revealed. Text uses the iOS body text style, so Dynamic Type still applies.
  The keyboard overlap is still `innerHeight − visualViewport.height −
  offsetTop`. While the keyboard is down the shell is `100lvh` in standalone
  (or `100%` in a tab). While it is up, `html` is pinned to
  `visualViewport.offsetTop + visualViewport.height` (`--shell-h`) so the
  format toolbar sits flush on whatever is directly above the keyboard.

- **Navigation.** The notes live in an Obsidian-style left sidebar. Search
  sits at the top of the panel, next to Aa and the options button, so the
  iOS keyboard does not cover it. Tapping it replaces the tree with results.
  The vault name, counts and gear stay at the bottom. Rows show the name
  only. Rename, move and delete are on a long-press menu. See Navigation and
  Settings in [DECISIONS.md](../DECISIONS.md).
- **Format toolbar.** While the editor is focused, a rounded dark pill sits
  at the bottom of the shell. With the keyboard up the shell height is the
  visual viewport's bottom and the bar's bottom margin is 0, so it sits
  flush on the accessory bar (or on the keys if iOS is not drawing one).
  It is a horizontally scrolling row of 44pt buttons with no visible
  scrollbar. Hide keyboard is pinned on the right and is the only control
  that blurs the editor. Every other action is a CodeMirror transaction
  from `format.js`: it wraps or toggles the selection or inserts at the
  caret, `preventDefault`s `pointerdown` so focus stays in the note, and
  goes through the history so undo still works. The order is the everyday
  Markdown on a phone, most used first:

  1. Task checkbox — Joe's notes are checklists.
  2. Bullet list, then numbered list — the other list starts.
  3. Bold, then italic — inline emphasis while typing.
  4. Link / wikilink — a URL selection becomes `[text](url)` with the
     caret in the label; anything else becomes `[[selection]]`.
  5. Heading — cycles none → H1 → H2 → H3 → off.
  6. Indent, then outdent — nest the current list (same as Tab / Shift-Tab).
  7. Quote, inline code, strikethrough, fenced code, highlight (`==`),
     horizontal rule — used, but less often than lists and emphasis.
  8. Undo, then redo — last in the scrolling row because iOS already has
     shake and three-finger undo; they are here so the bar can stand in
     for Obsidian's.

  Hide keyboard stays outside the scroller so it is always reachable.
- **List continuation.** Enter on a bullet (`-`, `*`, `+`), a task
  (`- [ ]` / `- [x]`, always continued as unchecked `- [ ]`), a numbered
  item (`1.` or `1)`, incremented), or a quote (`>`) inserts the same
  marker at the same indent. Enter on an empty item removes the marker
  and ends the list, or outdents one level when nested. Following numbered
  items are renumbered only when they already form a simple sequence;
  otherwise only the new line increments. Tab / Shift-Tab and the indent
  buttons nest and unnest. Line endings match the file: a CRLF note keeps
  `\r` on every touched line, and bytes elsewhere stay identical. The
  rules live in `list-continue.js` and are unit tested without a DOM.

## iOS form accessory bar

Joe's home-screen PWA on current iOS still draws Safari's form accessory
(the Prev / Next arrows and the checkmark / Done control) between the
format toolbar and the keyboard. Core Sample cannot hide that bar.

The bar is not a web element. It is `UIWebFormAccessory`, owned by
WebKit's private `WKContentView` as `inputAccessoryView`, and hosted in
the keyboard window (`UIRemoteKeyboardWindow`) *above* the page. A Safari
tab and a Home Screen PWA are still Safari; the page does not get a
`WKWebView` subclass to override.

A native `WKWebView` host can return `nil` from `inputAccessoryView`
(public API since iOS 13, WebKit r246229 / bugs.webkit.org/show_bug.cgi?id=198631).
Capacitor's `Keyboard.setAccessoryBarVisible({ isVisible: false })` is that
native override. Core Sample has no native wrapper, and the spec forbids
one.

The HTML attribute proposed in rdar://27763084 (`-apple-accessory-bar="none"`)
was never shipped. That radar has been Open since 9 August 2016. Ionic's
keyboard guide states the same limit: in a mobile browser or a PWA there is
no way to hide the accessory bar.

Tried and rejected:

| Trick | What happens on iOS Safari / PWA |
| --- | --- |
| `inputmode` on the CodeMirror `contenteditable` | `inputmode` is a hint for which keyboard to show. On iOS it is read from the editing host, not from children (WHATWG html#5322). It does not hide the accessory. `inputmode="none"` is meant to suppress the virtual keyboard entirely (and is unreliable on iOS besides: WebKit bug 200361). |
| `enterkeyhint` | Labels the software Return key (`enter`, `done`, `go`, …). On iOS the accessory's Done/checkmark is a separate dismiss control, not that Return key. Ignored for this purpose. |
| `interactive-widget=resizes-content` | Already in the viewport meta. Safari does not implement it; iOS stays `resizes-visual`. It would only change how the layout viewport resizes, not the accessory. |
| VirtualKeyboard API | Chromium-only. Safari does not implement `navigator.virtualKeyboard` or `virtualkeyboardpolicy`. |
| `readonly` + focus, blur/refocus, a hidden `<textarea>` | Breaks typing, autocorrect, dictation, and native selection on a `contenteditable`. CodeMirror 6 needs the browser to own those. |
| Guessing a 44px accessory height and adding it to `--keyboard-inset` | Would park the toolbar *above* the accessory with a permanent gap, which is the opposite of sitting flush on whatever is directly above the keyboard. |

CodeMirror, ProseMirror, and Obsidian-in-Safari cannot hide it either.
Obsidian's iOS app can, because it is native.

What we do instead: pin `html` to the visual viewport's bottom while the
keyboard is up (`layoutFrame.shell` → `--shell-h`, class `is-keyboard`)
and drop the format bar's bottom margin. `visualViewport` already excludes
the keys and the accessory, so the toolbar sits flush on the accessory.
The 30px gap on v32 was the 8px bottom margin plus shrinking `100lvh` by
an overlap computed from `innerHeight` (status-bar short of the screen)
instead of pinning to `offsetTop + height`.

## Left out on purpose

- Dataview beyond the TASK subset in [DECISIONS.md](../DECISIONS.md) (LIST,
  TABLE, CALENDAR, dataviewjs, `FROM [[link]]`, unknown functions). Those
  blocks stay visible as source plus a short unsupported note.
- Footnotes, `%%` comments, mermaid, PDF/audio/video embeds, tag chips,
  and HTML rendered as HTML.
- A full TeX engine. Math is a small MathML subset; no KaTeX, no CDN.
- Highlight.js / Prism / extra Lezer languages. Fence colors are a
  short token list for the languages above.
- Nested note embeds, Dataview inside an embed, and creating a note by
  tapping a missing embed (the box says it is missing; a wikilink still
  creates).
- The sidebar's Search field does not switch between views the way
  Obsidian's chevron does (Files, Search, Bookmarks and others). Core Sample
  has one panel. Bookmarks, tags and a vault switcher are not built; there
  is one vault, so the name is a label.

## Sources

- Obsidian Help, Views and editing mode: https://help.obsidian.md/edit-and-read
- Obsidian Help, Mobile app (mobile toolbar, navigation bar): https://help.obsidian.md/mobile
- Obsidian 1.9.10 mobile changelog (undo and redo first on the toolbar, keyboard resizing, links and checkboxes in Live Preview): https://obsidian.md/changelog/2025-08-18-mobile-v1.9.10/
- Obsidian Forum, Live Preview links on iOS (tap opens, tap and hold edits): https://forum.obsidian.md/t/suggestion-new-live-preview-behaviour-for-links-on-ios/31729
- Obsidian Forum, editing image links on mobile: https://forum.obsidian.md/t/mobile-edit-image-links-by-tapping-the-image/78885
- CodeMirror discussion, hiding Markdown syntax: https://discuss.codemirror.net/t/hide-markdown-syntax/7602
- segphault/codemirror-rich-markdoc: https://github.com/segphault/codemirror-rich-markdoc
- davidmyersdev/ink-mde: https://github.com/davidmyersdev/ink-mde
- fedoup/markdown-editor (one CM6 view, per-line reveal, stable heading height): https://github.com/fedoup/markdown-editor
- @yuya296/cm6-live-preview-core (per-element rich and raw states): https://www.npmjs.com/package/@yuya296/cm6-live-preview-core
- rdar://27763084, still Open, requesting a way to disable or replace WKWebView's default input accessory (proposed HTML attribute never shipped): https://openradar.appspot.com/27763084
- WebKit r246229 / bug 198631, iOS 13+: native clients may override `-[WKWebView inputAccessoryView]`: https://trac.webkit.org/changeset/246229/webkit and https://bugs.webkit.org/show_bug.cgi?id=198631
- Capacitor `Keyboard.setAccessoryBarVisible` (native WKWebView only; iPhone): https://capacitorjs.com/docs/apis/keyboard
- Ionic keyboard guide: a PWA or Safari tab cannot hide the accessory bar: https://ionicframework.com/docs/developing/keyboard
- WHATWG HTML issue 5322, `inputmode` / `enterkeyhint` apply to the editing host: https://github.com/whatwg/html/issues/5322
- WebKit bug 200361 / MDN BCD 7186, `inputmode=none` not implemented as specced on iOS Safari: https://bugs.webkit.org/show_bug.cgi?id=200361 and https://github.com/mdn/browser-compat-data/issues/7186
- Stack Overflow, the iOS accessory Done control is not the `enterkeyhint` Return key: https://stackoverflow.com/questions/72405834/combine-numeric-virtual-keyboard-and-enterkeyhint-on-mobile-safari

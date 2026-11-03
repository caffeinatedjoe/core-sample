import { commitFiles, deleteMeta, deleteOps, listOps, putFile, putOp, setMeta } from './db.js';
import { createDebouncedSaver } from './save.js';
import {
  loadSession,
  makeFile,
  notePathFromName,
  noteTitle,
  pickCurrent,
  planWikilink,
} from './notes.js';
import { listBrowser, moveTargets, rememberRecent } from './browser.js';
import { buildBackup, mergeBackup, parseBackup } from './backup.js';
import {
  ancestorFolders,
  folderDestination,
  liveNotes,
  noteDestination,
  notesInFolder,
  parentPath,
  planEmptyTrash,
  planFileMove,
  planFileRename,
  planFolderMove,
  planFolderRename,
  planRestore,
  planTrash,
} from './organize.js';
import { fileFromRemote, folderList, planDownload } from './github-api.js';
import { eraseLocalNotes, loadGithubSettings } from './github-store.js';
import { mountGithub } from './github-ui.js';
import { embedImage, loadEmbedBlob, OFFLINE_IMAGE_REASON, startImagePrefetch } from './images.js';
import { createAutoSync, loadConflictRemote } from './github-sync.js';
import { basename } from './embeds.js';
import { mountConflictScreen } from './conflict-ui.js';
import { createImageViewer } from './image-viewer.js';
import { createLiveEditor } from './live-editor.js';
import { headingOffset } from './live-rules.js';

const SAVE_DELAY = 400;

// `createEditor` is for tests that run without a real DOM.
export function mountApp(doc, db, { createEditor = createLiveEditor } = {}) {
  const host = doc.getElementById('source');
  const title = doc.getElementById('note-title');
  const status = doc.getElementById('save-status');
  const sheet = doc.getElementById('notes-sheet');
  const list = doc.getElementById('notes-list');
  const form = doc.getElementById('new-note-form');
  const nameInput = doc.getElementById('new-note-name');
  const formError = doc.getElementById('new-note-error');
  const search = doc.getElementById('notes-search');
  const panelBox = doc.getElementById('action-panel');
  const backupFile = doc.getElementById('backup-file');

  let files = [];
  let folders = [];
  let recent = [];
  let expanded = new Set();
  let query = '';
  let panel = null;
  let current = null;
  let erasing = false;
  let holding = false;

  let sync = null;
  const syncStatus = doc.getElementById('sync-status');
  const saver = createDebouncedSaver({
    delay: SAVE_DELAY,
    write: async (note) => {
      if (erasing) return undefined;
      await putFile(db, note);
      const index = files.findIndex((item) => item.path === note.path);
      if (index >= 0) files[index] = { ...files[index], ...note };
      if (note.dirty) await sync?.noteEdited(note);
    },
    onStatus: (state) => setStatus(state),
  });

  function live() {
    return liveNotes(files);
  }

  function snapshot() {
    return {
      path: current.path,
      content: current.content,
      kind: current.kind || 'markdown',
      encoding: current.encoding || 'utf-8',
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      trashedAt: current.trashedAt || null,
      remoteSha: typeof current.remoteSha === 'string' ? current.remoteSha : null,
      baseSha: typeof current.baseSha === 'string' ? current.baseSha : null,
      dirty: current.dirty === true,
      conflict: current.conflict === true,
      conflictCopy: current.conflictCopy === true,
      conflictAt: current.conflictAt || null,
      conflictReason: current.conflictReason || '',
      conflictRemote: typeof current.conflictRemote === 'string' ? current.conflictRemote : '',
      conflictRemoteSha: current.conflictRemoteSha || '',
      conflictBase: typeof current.conflictBase === 'string' ? current.conflictBase : '',
      backup: current.backup === true,
      origin: current.origin || '',
      localOnly: current.localOnly === true,
      syncedAt: current.syncedAt || null,
      syncedCommit: current.syncedCommit || '',
      conflictRemoteAt: current.conflictRemoteAt || null,
      conflictRemoteKnown: current.conflictRemoteKnown === true,
      conflictCopyPath: current.conflictCopyPath || '',
    };
  }

  function setStatus(state, detail) {
    if (state === 'saving') status.textContent = 'Saving…';
    else if (state === 'saved') status.textContent = 'Saved on this device';
    else if (state === 'error') status.textContent = "Couldn't save. Your text is still here.";
    else if (state === 'missing') status.textContent = `No note named ${detail}`;
    else if (state === 'ambiguous') status.textContent = `More than one note named ${detail}`;
    else if (state === 'invalid') status.textContent = detail;
  }

  let embedTicket = 0;
  const embedUrls = new Set();
  const embedBlobs = new WeakMap();
  const embedCache = new Map();
  const viewerUrls = new Set();
  const photos = createImageViewer(doc, doc.getElementById('image-viewer'), {
    onClose() {
      for (const url of viewerUrls) {
        const shown = source.embedNodes().some((node) => node.querySelector('img')?.getAttribute('src') === url);
        if (!shown) URL.revokeObjectURL(url);
      }
      viewerUrls.clear();
    },
  });

  const source = createEditor(host, {
    onChange: rememberEdit,
    onBlur: flushNow,
    onToggle: toggledTask,
    onTap: tapped,
    hydrate: hydrateEmbed,
  });
  Object.defineProperty(host, 'value', { configurable: true, get: () => source.value });

  function revokeEmbed(url) {
    if (!url || !embedUrls.has(url)) return;
    if (photos.isUsing(url)) return;
    embedUrls.delete(url);
    URL.revokeObjectURL(url);
  }

  function revokeEmbeds() {
    embedCache.clear();
    for (const url of [...embedUrls]) revokeEmbed(url);
  }

  function closeViewer() {
    photos.close({ animate: false, restoreFocus: false });
  }

  async function embedSettings() {
    try {
      return await loadGithubSettings(db);
    } catch {
      return { token: '', repo: '', branch: '', root: '' };
    }
  }

  async function loadEmbedSrc(embed) {
    const settings = await embedSettings();
    const result = await loadEmbedBlob(db, {
      link: embed,
      notePath: current && current.path ? current.path : '',
      repo: settings.repo,
      branch: settings.branch,
      root: settings.root,
      token: settings.token,
      fetchImpl: globalThis.fetch.bind(globalThis),
      offline: browserOffline(),
    });
    if (result.status !== 'ready' || !result.blob) return '';
    const url = URL.createObjectURL(result.blob);
    if (!photos.isOpen()) {
      URL.revokeObjectURL(url);
      return '';
    }
    viewerUrls.add(url);
    return url;
  }

  function openViewer(target) {
    const drawn = new Map();
    for (const node of source.embedNodes()) {
      const pos = source.posOf(node);
      if (pos >= 0) drawn.set(pos, node);
    }
    const slides = [];
    let start = 0;
    for (const item of source.images()) {
      const { image } = item;
      if (image.kind === 'label') continue;
      const node = drawn.get(item.from) || drawn.get(item.to) || null;
      const img = node?.querySelector('img.embed-image') || null;
      const src = img?.getAttribute('src') || (image.kind === 'remote' ? image.src : '');
      const usable = /^(blob:|https:|data:image\/)/i.test(src);
      const embed = image.kind === 'embed' ? image.embed : '';
      if (!usable && !embed) continue;
      if (node && (node === target || node.contains(target))) start = slides.length;
      slides.push({
        src: usable ? src : '',
        blob: img ? embedBlobs.get(img) || null : null,
        alt: img?.getAttribute('alt') || node?.querySelector('.embed-fallback')?.textContent || image.alt || basename(image.name || ''),
        thumb: img || node,
        load: usable ? null : () => loadEmbedSrc(embed),
      });
    }
    if (!slides.length) return;
    photos.open({ slides, index: start, scrollEl: source.scrollEl });
  }

  function bindImageErrors(root) {
    for (const img of root.querySelectorAll('img.embed-image')) {
      if (img.dataset.embedBound === '1') continue;
      img.dataset.embedBound = '1';
      img.addEventListener('load', () => source.measure());
      img.addEventListener('error', () => {
        const src = img.getAttribute('src');
        const frame = doc.defaultView?.requestAnimationFrame?.bind(doc.defaultView) || ((fn) => fn());
        frame(() => {
          if (!img.isConnected || img.getAttribute('src') !== src || img.naturalWidth > 0) return;
          replaceBrokenImage(img);
        });
      });
    }
  }

  function showEmbedReason(node, reason) {
    if (!node) return;
    node.replaceChildren();
    const fallback = doc.createElement('button');
    fallback.type = 'button';
    fallback.className = 'embed-fallback';
    fallback.textContent = reason || 'Not found in vault';
    node.append(fallback);
    source.measure();
  }

  function replaceBrokenImage(img) {
    const node = img.closest('.embed');
    if (!node || !img.isConnected) return;
    const src = img.getAttribute('src') || '';
    if (node.dataset.embed) embedCache.delete(node.dataset.embed);
    if (src) revokeEmbed(src);
    showEmbedReason(node, "Couldn't display");
  }

  async function fetchEmbed(link, fresh) {
    const settings = await embedSettings();
    try {
      const result = await loadEmbedBlob(db, {
        link,
        notePath: current && current.path ? current.path : '',
        repo: settings.repo,
        branch: settings.branch,
        root: settings.root,
        token: settings.token,
        fetchImpl: globalThis.fetch.bind(globalThis),
        offline: browserOffline(),
        ...(fresh ? { fresh: true } : {}),
      });
      return { ...result, repo: settings.repo || '', url: '' };
    } catch {
      return { status: 'error', reason: browserOffline() ? OFFLINE_IMAGE_REASON : "Couldn't reach GitHub (offline)" };
    }
  }

  // One load per image link per open note. Widgets are redrawn as the caret
  // moves, so they share the blob and its object URL instead of refetching.
  function cachedEmbed(link, fresh = false) {
    if (!fresh && embedCache.has(link)) return embedCache.get(link);
    const entry = fetchEmbed(link, fresh);
    embedCache.set(link, entry);
    return entry;
  }

  function fillEmbed(node, entry) {
    if (entry.status !== 'ready' || !entry.blob) {
      showEmbedReason(node, entry.reason);
      return;
    }
    const made = embedImage(entry.blob, {
      createObjectURL: (blob) => {
        if (!entry.url) {
          entry.url = URL.createObjectURL(blob);
          embedUrls.add(entry.url);
        }
        return entry.url;
      },
      createElement: (tag) => doc.createElement(tag),
      width: node.dataset.width || '',
      height: node.dataset.height || '',
      name: entry.name,
      type: entry.type,
    });
    embedBlobs.set(made.img, entry.blob);
    made.img.dataset.imagePath = entry.path || '';
    made.img.dataset.imageRepo = entry.repo || '';
    node.replaceChildren(made.img);
    bindImageErrors(node);
  }

  async function hydrateEmbed(node, fresh = false) {
    const link = node.dataset.embed || '';
    if (!link) return;
    const ticket = embedTicket;
    const entry = await cachedEmbed(link, fresh);
    if (ticket !== embedTicket) return;
    fillEmbed(node, entry);
  }

  function retryEmbed(node) {
    if (!node || !node.isConnected) return;
    hydrateEmbed(node, true);
  }

  function showNote(note, { heading = '' } = {}) {
    const same = current && current.path === note.path;
    current = note;
    if (!same) {
      embedTicket += 1;
      closeViewer();
      revokeEmbeds();
      source.load(note.content);
    } else {
      source.value = note.content;
    }
    title.textContent = noteTitle(note);
    if (heading) scrollToHeading(heading);
  }

  function scrollToHeading(heading) {
    const at = headingOffset(source.value, heading);
    if (at >= 0) source.scrollToPos(at);
  }

  function clearEditor() {
    current = null;
    embedTicket += 1;
    closeViewer();
    revokeEmbeds();
    source.load('');
    title.textContent = '';
  }

  async function flushEditing() {
    if (!current) return true;
    current.content = source.value;
    try {
      await saver.flush();
      const stored = files.find((file) => file.path === current.path);
      if (stored) {
        stored.content = current.content;
        stored.updatedAt = current.updatedAt;
      }
      return true;
    } catch {
      return false;
    }
  }

  function syncOpen(pathMap) {
    if (current && pathMap && pathMap[current.path]) {
      const next = files.find((file) => file.path === pathMap[current.path] && !file.trashedAt);
      if (next) {
        showNote(next);
        setMeta(db, 'lastOpened', next.path).catch(() => {});
        recent = rememberRecent(recent, next.path);
        setMeta(db, 'recent', recent).catch(() => {});
        return;
      }
    }
    if (current) {
      const fresh = files.find((file) => file.path === current.path && !file.trashedAt);
      if (fresh) {
        current = fresh;
        if (source.value !== fresh.content) source.value = fresh.content;
        title.textContent = noteTitle(fresh);
        return;
      }
    }
    const next = pickCurrent(live(), null);
    if (!next) {
      clearEditor();
      return;
    }
    showNote(next);
    setMeta(db, 'lastOpened', next.path).catch(() => {});
  }

  async function persistPlan(result) {
    const previous = files.slice();
    await commitFiles(db, { put: result.put || [], remove: result.remove || [] });
    files = result.files;
    if (result.folders) {
      folders = result.folders;
      await setMeta(db, 'folders', folders);
    }
    if (result.pathMap) {
      recent = recent.map((path) => result.pathMap[path] || path);
      setMeta(db, 'recent', recent).catch(() => {});
    }
    syncOpen(result.pathMap);
    renderList();
    await notifyOrganize(previous, result);
  }

  async function notifyOrganize(previous, result) {
    if (!sync) return;
    const map = result.pathMap || {};
    const destinations = new Set(Object.values(map).filter((path) => path));
    for (const [from, to] of Object.entries(map)) {
      if (!to || to === from) continue;
      const prior = previous.find((file) => file.path === from);
      const next = (result.files || []).find((file) => file.path === to);
      if (!prior || prior.kind !== 'markdown' || !next) continue;
      const base = typeof prior.baseSha === 'string' && prior.baseSha ? prior.baseSha : (prior.remoteSha || '');
      await sync.noteRenamed({ from, to, baseSha: base, file: next });
    }
    for (const file of result.put || []) {
      if (!file || file.kind !== 'markdown' || destinations.has(file.path)) continue;
      const prior = previous.find((item) => item.path === file.path);
      if (file.trashedAt && !prior?.trashedAt) {
        const base = (prior && (prior.baseSha || prior.remoteSha)) || '';
        await sync.noteTrashed({ file, baseSha: typeof base === 'string' ? base : '' });
      } else if (prior?.trashedAt && !file.trashedAt) {
        await sync.noteRestored(file);
      } else if (file.dirty && !file.trashedAt) {
        await sync.noteEdited(file);
      }
    }
  }

  async function openPath(path, { heading = '' } = {}) {
    if (current && current.path !== path) {
      if (!(await flushEditing())) return;
    }
    const note = files.find((item) => item.path === path && !item.trashedAt);
    if (!note) {
      setStatus('missing', path.replace(/\.md$/i, ''));
      return;
    }
    showNote(note, { heading });
    await setMeta(db, 'lastOpened', path);
    recent = rememberRecent(recent, path);
    await setMeta(db, 'recent', recent);
    closeSheet();
  }

  function renderList() {
    const rows = listBrowser({
      files,
      folders,
      expanded: [...expanded],
      recent,
      query,
      currentPath: current ? current.path : '',
    });
    list.replaceChildren();
    for (const row of rows) list.append(renderRow(row));
  }

  function renderRow(row) {
    const item = doc.createElement('li');
    if (row.type === 'label' || row.type === 'trash-label') {
      item.className = 'browser-label';
      const text = doc.createElement('span');
      text.textContent = row.text;
      item.append(text);
      if (row.type === 'trash-label') item.append(textButton('Empty trash', () => {
        panel = { type: 'confirm-empty', count: row.count };
        renderPanel();
      }));
      return item;
    }
    if (row.type === 'empty') {
      item.className = 'browser-empty';
      item.textContent = row.text;
      return item;
    }
    if (row.type === 'trash') {
      item.className = 'trash-row';
      const name = doc.createElement('span');
      name.className = 'note-name';
      name.textContent = row.title;
      item.append(name, textButton('Restore', () => restoreNote(row.path)));
      return item;
    }
    const openBtn = doc.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'note-link';
    openBtn.style.paddingLeft = `${12 + row.depth * 16}px`;
    if (row.type === 'folder') {
      openBtn.textContent = `${row.open ? '▾' : '▸'} ${row.name}`;
      openBtn.addEventListener('click', () => toggleFolder(row.path));
    } else {
      if (row.current) openBtn.classList.add('is-current');
      const name = doc.createElement('span');
      name.className = 'note-name';
      name.textContent = row.title;
      const detail = doc.createElement('span');
      detail.className = 'note-path';
      detail.textContent = row.detail || row.path;
      openBtn.append(name, detail);
      openBtn.addEventListener('click', () => openPath(row.path));
    }
    item.className = 'browser-row';
    item.append(openBtn, textButton('Edit', () => openItem(row.path, row.type === 'folder' ? 'folder' : 'note')));
    return item;
  }

  function textButton(label, onClick, className = 'row-more') {
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = className;
    node.textContent = label;
    node.addEventListener('click', onClick);
    return node;
  }

  function panelButton(label, onClick, className) {
    return textButton(label, onClick, className || '');
  }

  function renderPanel() {
    panelBox.replaceChildren();
    if (!panel) {
      panelBox.hidden = true;
      return;
    }
    panelBox.hidden = false;
    if (panel.type === 'item') renderItemPanel();
    else if (panel.type === 'rename') renderRenamePanel();
    else if (panel.type === 'move') renderMovePanel();
    else if (panel.type === 'confirm-trash') renderTrashPanel();
    else if (panel.type === 'confirm-remove-folder') renderRemoveFolderPanel();
    else if (panel.type === 'confirm-empty') renderEmptyPanel();
    else if (panel.type === 'new-folder') renderFolderPanel();
    else if (panel.type === 'new-note') renderNestedNotePanel();
    else if (panel.type === 'backup') renderBackupPanel();
    else if (panel.type === 'import') renderImportPanel();
    else if (panel.type === 'confirm-replace') renderReplacePanel();
  }

  function closePanel() {
    panel = null;
    renderPanel();
  }

  function renderItemPanel() {
    const heading = doc.createElement('p');
    heading.textContent = panel.path;
    panelBox.append(heading);
    if (panel.kind === 'folder') {
      panelBox.append(
        panelButton('New note', () => { panel = { type: 'new-note', parent: panel.path }; renderPanel(); }),
        panelButton('New folder', () => { panel = { type: 'new-folder', parent: panel.path }; renderPanel(); }),
      );
    }
    panelBox.append(
      panelButton('Rename', () => { panel = { ...panel, type: 'rename' }; renderPanel(); }),
      panelButton('Move', () => { panel = { ...panel, type: 'move' }; renderPanel(); }),
      panelButton('Delete', () => askDelete(panel.path, panel.kind)),
      panelButton('Cancel', closePanel),
    );
  }

  function renderRenamePanel() {
    const input = namedField(panel.kind === 'folder' ? panel.path.split('/').pop() : panel.path.split('/').pop().replace(/\.md$/i, ''), 'New name');
    panelBox.append(
      input,
      panelButton('Save', () => renameItem(input.value)),
      panelButton('Cancel', closePanel),
    );
    input.focus();
    input.select();
  }

  function renderMovePanel() {
    const heading = doc.createElement('p');
    heading.textContent = 'Move to';
    panelBox.append(heading);
    for (const folder of moveTargets(files, folders, panel.path, panel.kind === 'folder')) {
      panelBox.append(panelButton(folder || 'Notes', () => moveItem(folder)));
    }
    panelBox.append(panelButton('Cancel', closePanel));
  }

  function renderTrashPanel() {
    const message = doc.createElement('p');
    const name = panel.kind === 'folder' ? panel.path : panel.path.replace(/\.md$/i, '');
    message.textContent = panel.kind === 'folder'
      ? `Move every note in “${name}” to Trash? You can restore them later.`
      : `Move “${name}” to Trash? You can restore it later.`;
    panelBox.append(message, panelButton('Move to Trash', () => trashItem(panel.path), 'danger'), panelButton('Cancel', closePanel));
  }

  function renderRemoveFolderPanel() {
    const message = doc.createElement('p');
    message.textContent = `Remove the empty folder “${panel.path}”?`;
    panelBox.append(message, panelButton('Remove', () => removeEmptyFolder(panel.path), 'danger'), panelButton('Cancel', closePanel));
  }

  function renderEmptyPanel() {
    const message = doc.createElement('p');
    message.textContent = `Permanently delete ${panel.count} ${panel.count === 1 ? 'note' : 'notes'} from Trash? This removes the text from this device.`;
    panelBox.append(message, panelButton('Delete', emptyTrash, 'danger'), panelButton('Cancel', closePanel));
  }

  function renderFolderPanel() {
    const input = namedField('', 'Folder name');
    panelBox.append(input, panelButton('Create folder', () => createFolder(panel.parent, input.value)), panelButton('Cancel', closePanel));
    input.focus();
  }

  function renderNestedNotePanel() {
    const input = namedField('', 'Note name');
    panelBox.append(input, panelButton('Create', () => createNote(input.value, panel.parent)), panelButton('Cancel', closePanel));
    input.focus();
  }

  function renderBackupPanel() {
    const message = doc.createElement('p');
    message.textContent = 'A backup is a file of the notes on this device.';
    panelBox.append(
      message,
      panelButton('Export backup', exportBackup),
      panelButton('Import backup', () => backupFile.click()),
      panelButton('Cancel', closePanel),
    );
  }

  function renderImportPanel() {
    const count = panel.backup.files.length;
    const message = doc.createElement('p');
    message.textContent = `This backup has ${count} ${count === 1 ? 'note' : 'notes'}.`;
    panelBox.append(
      message,
      panelButton('Add to this device', () => addBackup(panel.backup)),
      panelButton('Replace notes on this device', () => {
        panel = { type: 'confirm-replace', backup: panel.backup };
        renderPanel();
      }),
      panelButton('Cancel', closePanel),
    );
  }

  function renderReplacePanel() {
    const message = doc.createElement('p');
    message.textContent = 'Replace the notes on this device with this backup? Notes that are not in the backup will be removed. Export first if you still need them.';
    panelBox.append(message, panelButton('Replace', () => replaceBackup(panel.backup), 'danger'), panelButton('Cancel', closePanel));
  }

  function namedField(value, label) {
    const input = doc.createElement('input');
    input.type = 'text';
    input.value = value;
    input.maxLength = 120;
    input.enterKeyHint = 'done';
    input.autocomplete = 'off';
    input.autocapitalize = 'sentences';
    input.setAttribute('aria-label', label);
    return input;
  }

  function toggleFolder(path) {
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    setMeta(db, 'expanded', [...expanded]).catch(() => {});
    renderList();
  }

  function openItem(path, kind) {
    panel = { type: 'item', path, kind };
    formError.textContent = '';
    renderPanel();
  }

  function askDelete(path, kind) {
    if (kind === 'folder' && notesInFolder(files, path).length === 0) {
      panel = { type: 'confirm-remove-folder', path };
    } else {
      panel = { type: 'confirm-trash', path, kind };
    }
    renderPanel();
  }

  async function renameItem(name) {
    formError.textContent = '';
    if (!(await flushEditing())) {
      formError.textContent = "Couldn't save the note you're editing.";
      return;
    }
    const parent = parentPath(panel.path);
    try {
      let result;
      if (panel.kind === 'folder') {
        const to = folderDestination(parent, name, folders.filter((folder) => folder !== panel.path));
        result = planFolderRename(files, folders, panel.path, to, Date.now());
        remapExpanded(panel.path, to);
      } else {
        const to = noteDestination(parent, name, files.map((file) => file.path).filter((path) => path !== panel.path));
        result = planFileRename(files, panel.path, to, Date.now());
      }
      await persistPlan(result);
      closePanel();
    } catch (error) {
      formError.textContent = error.message;
    }
  }

  function remapExpanded(from, to) {
    const next = new Set();
    for (const folder of expanded) {
      if (folder === from) next.add(to);
      else if (folder.startsWith(`${from}/`)) next.add(`${to}${folder.slice(from.length)}`);
      else next.add(folder);
    }
    expanded = next;
    setMeta(db, 'expanded', [...expanded]).catch(() => {});
  }

  async function moveItem(folder) {
    formError.textContent = '';
    if (!(await flushEditing())) {
      formError.textContent = "Couldn't save the note you're editing.";
      return;
    }
    try {
      const now = Date.now();
      const result = panel.kind === 'folder'
        ? planFolderMove(files, folders, panel.path, folder, now)
        : planFileMove(files, panel.path, folder, now);
      if (panel.kind === 'folder') {
        const name = panel.path.split('/').pop();
        remapExpanded(panel.path, folder ? `${folder}/${name}` : name);
      }
      await persistPlan(result);
      closePanel();
    } catch (error) {
      formError.textContent = error.message;
    }
  }

  async function trashItem(path) {
    formError.textContent = '';
    if (!(await flushEditing())) {
      formError.textContent = "Couldn't save the note you're editing.";
      return;
    }
    try {
      const result = planTrash(files, folders, path, Date.now());
      for (const folder of [...expanded]) {
        if (folder === path || folder.startsWith(`${path}/`)) expanded.delete(folder);
      }
      await setMeta(db, 'expanded', [...expanded]);
      await persistPlan(result);
      closePanel();
    } catch (error) {
      formError.textContent = error.message;
    }
  }

  async function removeEmptyFolder(path) {
    folders = folders.filter((folder) => folder !== path && !folder.startsWith(`${path}/`));
    expanded.delete(path);
    await setMeta(db, 'folders', folders);
    await setMeta(db, 'expanded', [...expanded]);
    closePanel();
    renderList();
  }

  async function restoreNote(path) {
    formError.textContent = '';
    if (!(await flushEditing())) {
      formError.textContent = "Couldn't save the note you're editing.";
      return;
    }
    try {
      const result = planRestore(files, path, Date.now());
      await persistPlan(result);
      await openPath(result.path);
    } catch (error) {
      formError.textContent = error.message;
    }
  }

  async function emptyTrash() {
    const result = planEmptyTrash(files);
    try {
      await persistPlan(result);
      closePanel();
    } catch (error) {
      formError.textContent = error.message;
    }
  }

  async function createFolder(parent, name) {
    formError.textContent = '';
    try {
      const path = folderDestination(parent, name, folders);
      folders = [...folders, path];
      if (parent) expanded.add(parent);
      expanded.add(path);
      await setMeta(db, 'folders', folders);
      await setMeta(db, 'expanded', [...expanded]);
      closePanel();
      renderList();
    } catch (error) {
      formError.textContent = error.message;
    }
  }

  async function createNote(name, folder) {
    formError.textContent = '';
    let path;
    try {
      path = notePathFromName(name, files.map((file) => file.path), folder);
    } catch (error) {
      formError.textContent = error.message;
      return;
    }
    if (!(await flushEditing())) {
      formError.textContent = "Couldn't save the note you're editing.";
      return;
    }
    const titleText = path.split('/').pop().replace(/\.md$/i, '');
    const note = { ...makeFile(path, `# ${titleText}\n\n`), dirty: true, origin: 'user' };
    try {
      await putFile(db, note);
      await setMeta(db, 'lastOpened', path);
    } catch {
      formError.textContent = "Couldn't save the new note.";
      return;
    }
    files.push(note);
    for (const ancestor of ancestorFolders(path)) expanded.add(ancestor);
    await setMeta(db, 'expanded', [...expanded]);
    recent = rememberRecent(recent, path);
    await setMeta(db, 'recent', recent);
    nameInput.value = '';
    showNote(note);
    closeSheet();
    sync?.noteEdited(note);
    source.focus();
  }

  async function exportBackup() {
    if (!(await flushEditing())) {
      formError.textContent = "Couldn't save the open note before export.";
      return;
    }
    const payload = buildBackup(files, {
      folders,
      lastOpened: current ? current.path : null,
      recent,
    });
    const json = JSON.stringify(payload);
    const file = new File([json], 'core-sample-backup.json', { type: 'application/json' });
    const nav = doc.defaultView?.navigator;
    if (nav?.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: 'Core Sample backup' });
        return true;
      } catch (error) {
        if (error?.name === 'AbortError') return false;
      }
    }
    const url = URL.createObjectURL(file);
    const link = doc.createElement('a');
    link.href = url;
    link.download = 'core-sample-backup.json';
    link.rel = 'noopener';
    doc.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return true;
  }

  async function addBackup(backup) {
    try {
      const merged = mergeBackup(files, folders, backup);
      await commitFiles(db, { put: merged.put });
      files = merged.files;
      folders = merged.folders;
      await setMeta(db, 'folders', folders);
      formError.textContent = merged.keptAside.length
        ? `Added the backup. ${merged.keptAside.length} notes were kept beside ones already here.`
        : 'Added the backup.';
      closePanel();
      renderList();
    } catch (error) {
      formError.textContent = error.message;
    }
  }

  async function replaceBackup(backup) {
    if (!(await flushEditing())) {
      formError.textContent = "Couldn't save the open note.";
      return;
    }
    try {
      await commitFiles(db, {
        remove: files.map((file) => file.path),
        put: backup.files,
      });
      files = backup.files.map((file) => ({ ...file }));
      folders = [...backup.folders];
      recent = [...backup.recent];
      expanded = new Set();
      await setMeta(db, 'folders', folders);
      await setMeta(db, 'recent', recent);
      await setMeta(db, 'expanded', []);
      if (backup.lastOpened) await setMeta(db, 'lastOpened', backup.lastOpened);
      const next = pickCurrent(live(), backup.lastOpened);
      if (next) showNote(next);
      else clearEditor();
      formError.textContent = 'Replaced the notes on this device.';
      closePanel();
      renderList();
    } catch (error) {
      formError.textContent = error.message;
    }
  }

  function openSheet() {
    formError.textContent = '';
    renderList();
    renderPanel();
    sheet.hidden = false;
  }

  function closeSheet() {
    sheet.hidden = true;
    closePanel();
  }

  function rememberEdit() {
    if (holding || erasing || !current) return;
    if (source.value !== current.content) {
      current.dirty = true;
      current.content = source.value;
      current.updatedAt = Date.now();
    }
    title.textContent = noteTitle(current);
    saver.schedule(snapshot);
  }

  doc.getElementById('notes-button').addEventListener('click', openSheet);
  doc.getElementById('notes-close').addEventListener('click', closeSheet);
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet) closeSheet();
  });
  search.addEventListener('input', () => {
    query = search.value;
    renderList();
  });
  doc.getElementById('new-folder-button').addEventListener('click', () => {
    panel = { type: 'new-folder', parent: '' };
    formError.textContent = '';
    renderPanel();
  });
  doc.getElementById('backup-button').addEventListener('click', () => {
    panel = { type: 'backup' };
    formError.textContent = '';
    renderPanel();
  });
  const exportBackupButton = doc.getElementById('export-backup');
  if (exportBackupButton) {
    exportBackupButton.addEventListener('click', () => {
      exportBackup().catch((error) => {
        formError.textContent = error && error.message ? error.message : "Couldn't export the backup.";
      });
    });
  }
  backupFile.addEventListener('change', async () => {
    const chosen = backupFile.files && backupFile.files[0];
    backupFile.value = '';
    if (!chosen) return;
    try {
      panel = { type: 'import', backup: parseBackup(await chosen.text()) };
      formError.textContent = '';
      renderPanel();
    } catch (error) {
      formError.textContent = error.message;
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    createNote(nameInput.value, '');
  });

  let linkNav = null;

  async function followWikilink(target, heading) {
    const plan = planWikilink(files, target);
    if (plan.action === 'ambiguous') {
      setStatus('ambiguous', target);
      return;
    }
    if (plan.action === 'invalid') {
      setStatus('invalid', plan.message);
      return;
    }
    if (plan.action === 'open') {
      await openPath(plan.path, { heading });
      return;
    }
    if (plan.action === 'restore') {
      if (!(await flushEditing())) {
        setStatus('error');
        return;
      }
      try {
        const result = planRestore(files, plan.path, Date.now());
        await persistPlan(result);
        await openPath(result.path, { heading });
      } catch {
        setStatus('error');
      }
      return;
    }
    if (!(await flushEditing())) {
      setStatus('error');
      return;
    }
    const note = { ...makeFile(plan.path, `# ${plan.title}\n\n`), dirty: true, origin: 'user' };
    try {
      await putFile(db, note);
      await setMeta(db, 'lastOpened', plan.path);
    } catch {
      setStatus('error');
      return;
    }
    files.push(note);
    sync?.noteEdited(note);
    for (const ancestor of ancestorFolders(plan.path)) expanded.add(ancestor);
    recent = rememberRecent(recent, plan.path);
    await setMeta(db, 'recent', recent);
    showNote(note, { heading });
    closeSheet();
  }

  function toggledTask() {
    flushNow();
  }

  function openExternal(href) {
    const link = doc.createElement('a');
    link.href = href;
    link.rel = 'noopener';
    doc.body.append(link);
    link.click();
    link.remove();
  }

  function tapped(plan, node) {
    if (plan.type === 'external') {
      openExternal(plan.href);
      return;
    }

    if (plan.type === 'image') {
      openViewer(node);
      return;
    }

    if (plan.type === 'embed-retry') {
      retryEmbed(node.closest?.('.embed'));
      return;
    }

    if (plan.type === 'wikilink') {
      if (linkNav) return;
      linkNav = followWikilink(plan.target, plan.heading).finally(() => {
        linkNav = null;
      });
      return;
    }

    if (plan.type === 'local-link') {
      let href = plan.href;
      try { href = decodeURIComponent(href); } catch { /* keep the raw href */ }
      href = href.trim().replace(/^\.\//, '');
      if (href.startsWith('#')) {
        scrollToHeading(href.slice(1));
        return;
      }
      if (linkNav) return;
      linkNav = followWikilink(href, '').finally(() => {
        linkNav = null;
      });
    }
  }

  function flushNow() {
    if (erasing || !current) return;
    current.content = source.value;
    saver.flush().catch(() => {});
  }

  function holdEditor(held) {
    holding = Boolean(held);
    source.readOnly = holding;
  }

  async function replaceFile(file) {
    await putFile(db, file);
    const index = files.findIndex((item) => item.path === file.path);
    if (index >= 0) files[index] = file;
    else files.push(file);
    if (current && current.path === file.path) {
      if (source.value !== file.content) showNote(file);
      else current = file;
    }
  }

  async function applyDownload(loaded, mode) {
    if (!(await flushEditing())) {
      throw new Error("Couldn't save the open note. Nothing was replaced.");
    }
    const plan = planDownload(files, loaded, mode);
    if (!plan.writes.length) {
      startImagePrefetch(db);
      return { downloaded: 0, skipped: plan.skipped.length, empty: loaded.length === 0 };
    }
    const now = Date.now();
    const writes = plan.writes.map((note) => fileFromRemote(
      { localPath: note.localPath },
      note.content,
      note.sha,
      now,
    ));
    await commitFiles(db, { put: writes, remove: plan.remove });
    if (plan.remove.length) {
      const removed = new Set(plan.remove);
      files = files.filter((file) => !removed.has(file.path));
    }
    for (const file of writes) {
      const index = files.findIndex((item) => item.path === file.path);
      if (index >= 0) files[index] = file;
      else files.push(file);
    }
    if (mode === 'replace') {
      folders = folderList(files.map((file) => file.path));
      recent = [];
      expanded = new Set(folders);
      await setMeta(db, 'folders', folders);
      await setMeta(db, 'recent', recent);
      await setMeta(db, 'expanded', [...expanded]);
    } else {
      for (const file of writes) {
        for (const folder of ancestorFolders(file.path)) {
          if (!folders.includes(folder)) folders.push(folder);
          expanded.add(folder);
        }
      }
      await setMeta(db, 'folders', folders);
      await setMeta(db, 'expanded', [...expanded]);
    }
    syncOpen();
    renderList();
    startImagePrefetch(db);
    return { downloaded: writes.length, skipped: plan.skipped.length, empty: false };
  }

  function browserOffline() {
    const nav = doc.defaultView?.navigator || globalThis.navigator;
    return nav?.onLine === false;
  }

  async function eraseLocal() {
    erasing = true;
    try {
      await saver.discard();
      await eraseLocalNotes(db);
      files = [];
      folders = [];
      recent = [];
      expanded = new Set();
      clearEditor();
      renderList();
      setStatus('saved');
    } finally {
      erasing = false;
    }
  }

  function applySyncedFiles(nextFiles) {
    for (const file of nextFiles || []) {
      const index = files.findIndex((item) => item.path === file.path);
      if (index >= 0) files[index] = file;
      else files.push(file);
      if (!current || current.path !== file.path) continue;
      const typed = source.value !== current.content && source.value !== file.content;
      if (typed) continue;
      current = file;
      source.value = file.content;
      title.textContent = noteTitle(current);
    }
    renderList();
  }

  function applyRemoved(paths) {
    const gone = new Set(paths || []);
    files = files.filter((file) => !gone.has(file.path));
    recent = recent.filter((path) => !gone.has(path));
    setMeta(db, 'recent', recent).catch(() => {});
    if (current && gone.has(current.path)) {
      current = null;
      syncOpen();
    }
    renderList();
  }

  async function keepConflictRemote(notePath, fields) {
    const index = files.findIndex((item) => item.path === notePath);
    if (index < 0) return;
    const next = { ...files[index], ...fields };
    await putFile(db, next);
    files[index] = next;
    if (current && current.path === notePath) Object.assign(current, fields);
  }

  async function applyConflictPlan(plan) {
    for (const file of plan.put || []) {
      if (file && !file.backup && typeof file.content !== 'string') {
        throw new Error('That choice would leave the note empty. Nothing was saved.');
      }
    }
    const beforeFiles = files.map((file) => ({ ...file }));
    const beforeOps = await listOps(db);
    await commitFiles(db, { put: plan.put || [], remove: plan.remove || [] });
    const removed = new Set(plan.remove || []);
    files = files.filter((file) => !removed.has(file.path));
    for (const file of plan.put || []) {
      const index = files.findIndex((item) => item.path === file.path);
      if (index >= 0) files[index] = file;
      else files.push(file);
    }
    recent = recent.filter((path) => !removed.has(path));
    const quiet = new Set(plan.remove || []);
    for (const file of plan.put || []) {
      if (!file.dirty || file.backup || file.conflictCopy) quiet.add(file.path);
    }
    if (quiet.size) await deleteOps(db, [...quiet]);
    for (const file of plan.put || []) {
      if (file.dirty && !file.backup && !file.conflictCopy && !file.trashedAt) await sync.noteEdited(file);
    }
    if (current && (removed.has(current.path) || (plan.put || []).some((file) => file.path === current.path))) {
      const next = files.find((file) => file.path === (current && current.path) && !file.trashedAt);
      if (next) showNote(next);
      else syncOpen();
    }
    renderList();
    const queued = (plan.put || []).some((file) => file.dirty && !file.backup && !file.conflictCopy && !file.trashedAt);
    if (!queued && !browserOffline()) await sync.runNow('resolve');
    else await sync.refreshStatus();
    return {
      async undo() {
        await saver.discard();
        const created = (plan.put || []).map((file) => file.path).filter((notePath) => !beforeFiles.some((file) => file.path === notePath));
        const restore = beforeFiles.filter((file) => created.includes(file.path) || (plan.put || []).some((item) => item.path === file.path) || (plan.remove || []).includes(file.path));
        await commitFiles(db, { put: restore, remove: created });
        const nowOps = await listOps(db);
        if (nowOps.length) await deleteOps(db, nowOps.map((op) => op.id));
        for (const op of beforeOps) await putOp(db, op);
        files = beforeFiles.map((file) => ({ ...file }));
        if (current) {
          const next = files.find((file) => file.path === current.path && !file.trashedAt);
          if (next) showNote(next);
          else syncOpen();
        }
        renderList();
        await sync.refreshStatus();
      },
    };
  }

  async function dismissConflictCopy(notePath) {
    const file = files.find((item) => item.path === notePath);
    if (!file) return;
    const next = { ...file, trashedAt: Date.now() };
    await putFile(db, next);
    const index = files.findIndex((item) => item.path === notePath);
    if (index >= 0) files[index] = next;
    renderList();
    await sync?.refreshStatus();
  }

  sync = createAutoSync({
    db,
    fetchImpl: globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined,
    offline: () => browserOffline(),
    beforeSync: () => saver.flush(),
    onStatus(text, state = {}) {
      if (!syncStatus) return;
      syncStatus.textContent = text;
      const open = state.conflict === true || Number(state.copies) > 0;
      syncStatus.setAttribute('aria-disabled', open ? 'false' : 'true');
      syncStatus.classList?.toggle?.('sync-status-conflict', open);
    },
    onApplied: applySyncedFiles,
    onRemoved: applyRemoved,
    onPulled: () => startImagePrefetch(db),
  });

  const conflictScreen = mountConflictScreen(doc, {
    files: () => files,
    apply: applyConflictPlan,
    dismiss: dismissConflictCopy,
    loadRemote: (file, sibling) => loadConflictRemote({
      db,
      file,
      sibling,
      fetchImpl: globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined,
      offline: () => browserOffline(),
    }),
    keepRemote: keepConflictRemote,
  });
  syncStatus?.addEventListener('click', () => {
    if (syncStatus.getAttribute('aria-disabled') === 'true') return;
    conflictScreen.open();
  });

  const github = mountGithub(doc, db, {
    flush: flushEditing,
    exportBackup,
    files: () => files,
    current: () => current,
    replaceFile,
    applyDownload,
    eraseLocal,
    hold: holdEditor,
  });

  function hideFlush() {
    flushNow();
    sync?.flushNow();
  }

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') hideFlush();
    else sync?.visible();
  });
  window.addEventListener('pagehide', hideFlush);
  window.addEventListener('online', () => sync?.online());

  return {
    flush: flushNow,
    async start() {
      const session = await loadSession(db);
      files = session.files;
      folders = session.folders;
      recent = session.recent;
      expanded = new Set(session.expanded || []);
      if (!session.expanded && session.current) {
        for (const folder of ancestorFolders(session.current.path)) expanded.add(folder);
      }
      deleteMeta(db, 'editorMode').catch(() => {});
      if (session.current) {
        showNote(session.current);
        await setMeta(db, 'lastOpened', session.current.path);
        recent = rememberRecent(recent, session.current.path);
        await setMeta(db, 'recent', recent);
      }
      await github.refresh();
      github.resume();
      setStatus('saved');
      await sync.start();
    },
  };
}

import { renderMarkdown } from './markdown.js';
import { toggleChecklist } from './checklist.js';
import { commitFiles, putFile, setMeta } from './db.js';
import { createDebouncedSaver } from './save.js';
import {
  loadSession,
  makeFile,
  notePathFromName,
  noteTitle,
  pickCurrent,
  planWikilink,
} from './notes.js';
import { planPreviewClick } from './preview-tap.js';
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
import { embedImage, loadEmbedBlob, vaultIndexFor } from './images.js';
import { createImageViewer } from './image-viewer.js';

const SAVE_DELAY = 400;

export function mountApp(doc, db) {
  const source = doc.getElementById('source');
  const preview = doc.getElementById('preview');
  const title = doc.getElementById('note-title');
  const status = doc.getElementById('save-status');
  const sheet = doc.getElementById('notes-sheet');
  const list = doc.getElementById('notes-list');
  const form = doc.getElementById('new-note-form');
  const nameInput = doc.getElementById('new-note-name');
  const formError = doc.getElementById('new-note-error');
  const modeSource = doc.getElementById('mode-source');
  const modePreview = doc.getElementById('mode-preview');
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
  let mode = 'source';
  let erasing = false;
  let holding = false;

  const saver = createDebouncedSaver({
    delay: SAVE_DELAY,
    write: (note) => {
      if (erasing) return undefined;
      return putFile(db, note);
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
      dirty: current.dirty === true,
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

  function applyMode(next, { persist = true } = {}) {
    mode = next === 'preview' ? 'preview' : 'source';
    source.hidden = mode !== 'source';
    preview.hidden = mode !== 'preview';
    modeSource.setAttribute('aria-pressed', mode === 'source' ? 'true' : 'false');
    modePreview.setAttribute('aria-pressed', mode === 'preview' ? 'true' : 'false');
    if (mode === 'preview') paintPreview();
    if (persist) setMeta(db, 'editorMode', mode).catch(() => {});
  }

  let embedTicket = 0;
  const embedUrls = new Set();
  const viewerUrls = new Set();
  const photos = createImageViewer(doc, doc.getElementById('image-viewer'), {
    onClose() {
      for (const url of viewerUrls) {
        const shown = [...preview.querySelectorAll('img')].some((img) => img.getAttribute('src') === url);
        if (!shown) URL.revokeObjectURL(url);
      }
      viewerUrls.clear();
    },
  });

  function revokeEmbed(url) {
    if (!url || !embedUrls.has(url)) return;
    if (photos.isUsing(url)) return;
    embedUrls.delete(url);
    URL.revokeObjectURL(url);
  }

  function revokeEmbeds() {
    for (const url of [...embedUrls]) revokeEmbed(url);
  }

  function closeViewer() {
    photos.close({ animate: false, restoreFocus: false });
  }

  async function loadEmbedSrc(embed) {
    let settings = { token: '', repo: '', branch: '', root: '' };
    try {
      settings = await loadGithubSettings(db);
    } catch {
      settings = { token: '', repo: '', branch: '', root: '' };
    }
    const index = await vaultIndexFor(db, settings, globalThis.fetch.bind(globalThis));
    const result = await loadEmbedBlob(db, {
      link: embed,
      notePath: current && current.path ? current.path : '',
      paths: index.paths || [],
      attachmentFolderPath: index.attachmentFolderPath || '',
      repo: settings.repo,
      branch: index.branch || settings.branch,
      root: settings.root,
      token: settings.token,
      fetchImpl: globalThis.fetch.bind(globalThis),
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
    const slides = [];
    let start = 0;
    for (const node of preview.querySelectorAll('.embed')) {
      const img = node.querySelector('img.embed-image');
      const embed = node.dataset.embed || '';
      const src = img?.getAttribute('src') || '';
      const usable = /^(blob:|https:|data:image\/)/i.test(src);
      if (!usable && !embed) continue;
      if (img && (img === target || img.contains(target))) start = slides.length;
      slides.push({
        src: usable ? src : '',
        alt: img?.getAttribute('alt') || node.querySelector('.embed-fallback')?.textContent || '',
        thumb: img || node,
        load: usable ? null : () => loadEmbedSrc(embed),
      });
    }
    if (!slides.length) return;
    photos.open({ slides, index: start, scrollEl: preview });
  }

  function paintPreview() {
    const ticket = ++embedTicket;
    closeViewer();
    revokeEmbeds();
    const scroll = preview.scrollTop;
    preview.innerHTML = renderMarkdown(source.value);
    preview.scrollTop = scroll;
    bindImageErrors(preview);
    if (mode === 'preview') hydrateEmbeds(ticket);
  }

  function bindImageErrors(root) {
    for (const img of root.querySelectorAll('img.embed-image')) {
      if (img.dataset.embedBound === '1') continue;
      img.dataset.embedBound = '1';
      img.addEventListener('error', () => replaceBrokenImage(img));
      if (img.complete && img.getAttribute('src') && img.naturalWidth === 0) replaceBrokenImage(img);
    }
  }

  function replaceBrokenImage(img) {
    const host = img.closest('.embed');
    if (!host || !img.isConnected) return;
    const label = img.getAttribute('alt') || 'image';
    host.replaceChildren();
    const fallback = doc.createElement('span');
    fallback.className = 'embed-fallback';
    fallback.textContent = label;
    host.append(fallback);
  }

  async function hydrateEmbeds(ticket) {
    const nodes = [...preview.querySelectorAll('[data-embed]')];
    if (!nodes.length) return;
    let settings = { token: '', repo: '', branch: '', root: '' };
    try {
      settings = await loadGithubSettings(db);
    } catch {
      settings = { token: '', repo: '', branch: '', root: '' };
    }
    if (ticket !== embedTicket) return;
    const index = await vaultIndexFor(db, settings, globalThis.fetch.bind(globalThis));
    if (ticket !== embedTicket) return;
    const notePath = current && current.path ? current.path : '';
    for (const node of nodes) {
      if (ticket !== embedTicket || !node.isConnected) return;
      const link = node.dataset.embed || '';
      let result;
      try {
        result = await loadEmbedBlob(db, {
          link,
          notePath,
          paths: index.paths || [],
          attachmentFolderPath: index.attachmentFolderPath || '',
          repo: settings.repo,
          branch: index.branch || settings.branch,
          root: settings.root,
          token: settings.token,
          fetchImpl: globalThis.fetch.bind(globalThis),
        });
      } catch {
        continue;
      }
      if (ticket !== embedTicket || !node.isConnected || result.status !== 'ready') continue;
      const made = embedImage(result.blob, {
        createObjectURL: URL.createObjectURL.bind(URL),
        createElement: (tag) => doc.createElement(tag),
        width: node.dataset.width || '',
        height: node.dataset.height || '',
        name: result.name,
        type: result.type,
      });
      if (ticket !== embedTicket) {
        URL.revokeObjectURL(made.url);
        return;
      }
      embedUrls.add(made.url);
      node.replaceChildren(made.img);
      bindImageErrors(node);
    }
  }

  function showNote(note, { heading = '' } = {}) {
    current = note;
    source.value = note.content;
    title.textContent = noteTitle(note);
    paintPreview();
    if (heading && mode === 'preview') scrollToHeading(heading);
  }

  function scrollToHeading(heading) {
    const want = heading.trim().toLowerCase();
    for (const node of preview.querySelectorAll('[data-heading]')) {
      if ((node.dataset.heading || '').trim().toLowerCase() === want) {
        node.scrollIntoView({ block: 'start' });
        return;
      }
    }
  }

  function clearEditor() {
    current = null;
    source.value = '';
    title.textContent = '';
    closeViewer();
    revokeEmbeds();
    preview.replaceChildren();
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
        if (source.value !== fresh.content) {
          source.value = fresh.content;
          if (mode === 'preview') paintPreview();
        }
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
    const note = makeFile(path, `# ${titleText}\n\n`);
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
    if (mode === 'source') source.focus();
  }

  async function exportBackup() {
    if (!(await flushEditing())) {
      formError.textContent = "Couldn't save the open note before export.";
      return;
    }
    const payload = buildBackup(files, {
      folders,
      lastOpened: current ? current.path : null,
      editorMode: mode,
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
      applyMode(backup.editorMode, { persist: true });
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

  source.addEventListener('input', rememberEdit);
  source.addEventListener('blur', flushNow);
  modeSource.addEventListener('click', () => applyMode('source'));
  modePreview.addEventListener('click', () => {
    if (current) current.content = source.value;
    applyMode('preview');
  });
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
    const note = makeFile(plan.path, `# ${plan.title}\n\n`);
    try {
      await putFile(db, note);
      await setMeta(db, 'lastOpened', plan.path);
    } catch {
      setStatus('error');
      return;
    }
    files.push(note);
    for (const ancestor of ancestorFolders(plan.path)) expanded.add(ancestor);
    recent = rememberRecent(recent, plan.path);
    await setMeta(db, 'recent', recent);
    showNote(note, { heading });
    closeSheet();
  }

  preview.addEventListener('click', (event) => {
    const plan = planPreviewClick(event.target);
    if (plan.type === 'external' || plan.type === 'none') return;
    if (plan.preventDefault) event.preventDefault();

    if (plan.type === 'task') {
      if (holding) return;
      const next = toggleChecklist(source.value, plan.index);
      const selStart = source.selectionStart;
      const selEnd = source.selectionEnd;
      const sourceScroll = source.scrollTop;
      const previewScroll = preview.scrollTop;
      source.value = next;
      source.selectionStart = selStart;
      source.selectionEnd = selEnd;
      source.scrollTop = sourceScroll;
      if (current) {
        if (next !== current.content) current.dirty = true;
        current.content = next;
        current.updatedAt = Date.now();
        title.textContent = noteTitle(current);
      }
      paintPreview();
      preview.scrollTop = previewScroll;
      saver.schedule(snapshot);
      saver.flush().catch(() => {});
      return;
    }

    if (plan.type === 'image') {
      openViewer(event.target);
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
  });

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
    return { downloaded: writes.length, skipped: plan.skipped.length, empty: false };
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

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') flushNow();
  });
  window.addEventListener('pagehide', flushNow);

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
      applyMode(session.mode, { persist: false });
      if (session.current) {
        showNote(session.current);
        await setMeta(db, 'lastOpened', session.current.path);
        recent = rememberRecent(recent, session.current.path);
        await setMeta(db, 'recent', recent);
      }
      await github.refresh();
      github.resume();
      setStatus('saved');
    },
  };
}

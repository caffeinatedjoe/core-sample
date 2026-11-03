import { commitFiles, deleteMeta, deleteOps, getMeta, listOps, putFile, putOp, setMeta } from './db.js';
import { createDebouncedSaver } from './save.js';
import {
  loadSession,
  makeFile,
  notePathFromName,
  noteTitle,
  pickCurrent,
  planWikilink,
} from './notes.js';
import { listBrowser, moveTargets, rememberRecent, vaultSummary } from './browser.js';
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
import {
  ATTACHMENT_FOLDER,
  attachmentDestination,
  embedLinkFor,
  extraAttachmentFiles,
  formatByteSize,
  isImagePath,
  makeBinaryFile,
  mergePlans,
  noteAttachmentFolder,
  planRenameAttachmentFolder,
} from './attachments.js';
import { fileFromRemote, fileFromRemoteAttachment, folderList, planDownload } from './github-api.js';
import { eraseLocalNotes, loadGithubSettings } from './github-store.js';
import { mountGithub } from './github-ui.js';
import { embedImage, loadAttachmentBytes, loadEmbedBlob, OFFLINE_IMAGE_REASON, rememberImage, startImagePrefetch } from './images.js';
import { createAutoSync, loadConflictRemote, syncAlert, syncAlertFocus, syncAlertTone } from './github-sync.js';
import { mountDrawer } from './drawer.js';
import { LONG_PRESS, SLOP } from './drawer-gesture.js';
import { basename, extensionOf, mimeFor } from './embeds.js';
import { mountConflictScreen } from './conflict-ui.js';
import { createImageViewer } from './image-viewer.js';
import { createLiveEditor } from './live-editor.js';
import { headingOffset } from './live-rules.js';
import { applyTaskToggle } from './tasks.js';
import { createTaskIndex, isIndexableNote } from './task-index.js';
import { dataviewResult } from './dql.js';

const SAVE_DELAY = 400;

// `createEditor` is for tests that run without a real DOM.
export function mountApp(doc, db, { createEditor = createLiveEditor } = {}) {
  const host = doc.getElementById('source');
  const title = doc.getElementById('note-title');
  const status = doc.getElementById('save-status');
  const list = doc.getElementById('notes-list');
  const form = doc.getElementById('new-note-form');
  const nameInput = doc.getElementById('new-note-name');
  const formError = doc.getElementById('new-note-error');
  const search = doc.getElementById('notes-search');
  const searchCase = doc.getElementById('search-case');
  const searchCancel = doc.getElementById('search-cancel');
  const searchOptions = doc.getElementById('search-options');
  const searchOptionsPanel = doc.getElementById('search-options-panel');
  const searchContent = doc.getElementById('search-content');
  const drawerPanel = list?.closest?.('.drawer-panel') || doc.querySelector?.('.drawer-panel');
  const panelBox = doc.getElementById('action-panel');
  const backupFile = doc.getElementById('backup-file');
  const backupBox = doc.getElementById('backup-panel');
  const backupStatus = doc.getElementById('backup-status');
  const vaultName = doc.getElementById('vault-name');
  const vaultCount = doc.getElementById('vault-count');

  let files = [];
  let folders = [];
  let recent = [];
  let expanded = new Set();
  let query = '';
  let searching = false;
  let vaultPaths = null;
  let matchCase = false;
  let panel = null;
  let backupStep = null;
  let current = null;
  let erasing = false;
  let holding = false;
  let booting = true;

  let sync = null;
  let syncConflicts = false;
  let syncKind = '';
  const syncStatus = doc.getElementById('sync-status');

  // The note screen shows the status only when it needs a tap; Settings
  // always shows it, with the detail and Retry.
  function paintSync(text, state = {}) {
    const alert = syncAlert(state);
    syncKind = alert;
    syncConflicts = alert === 'conflict' || alert === 'copies';
    if (syncStatus) {
      syncStatus.textContent = text;
      syncStatus.hidden = !alert;
      syncStatus.setAttribute('aria-disabled', alert ? 'false' : 'true');
      if (alert) syncStatus.setAttribute('data-alert', alert);
      else syncStatus.removeAttribute('data-alert');
      const tone = syncAlertTone(alert);
      if (tone) syncStatus.setAttribute('data-tone', tone);
      else syncStatus.removeAttribute('data-tone');
    }
    const line = doc.getElementById('settings-sync-status');
    if (line) line.textContent = text || 'Not connected to GitHub';
    const detail = doc.getElementById('settings-sync-detail');
    if (detail) {
      detail.textContent = state.detail || '';
      detail.hidden = !state.detail;
    }
    const retry = doc.getElementById('sync-retry');
    if (retry) retry.hidden = !state.configured;
    const conflicts = doc.getElementById('sync-conflicts');
    if (conflicts) conflicts.hidden = !syncConflicts;
  }
  const taskIndex = createTaskIndex();

  const saver = createDebouncedSaver({
    delay: SAVE_DELAY,
    write: async (note) => {
      if (erasing) return undefined;
      await putFile(db, note);
      const index = files.findIndex((item) => item.path === note.path);
      if (index >= 0) files[index] = { ...files[index], ...note };
      updateIndexPath(note);
      if (note.dirty) await sync?.noteEdited(note);
    },
    onStatus: (state) => setStatus(state),
  });

  function live() {
    return liveNotes(files);
  }

  function notesForIndex() {
    return live().filter(isIndexableNote).map((file) => ({ path: file.path, content: file.content }));
  }

  function rebuildIndex() {
    taskIndex.rebuild(notesForIndex());
    source.refreshDataview?.();
  }

  function updateIndexPath(file) {
    if (!file?.path) return;
    if (isIndexableNote(file)) taskIndex.replace(file.path, file.content);
    else taskIndex.remove(file.path);
    source.refreshDataview?.();
  }

  function applyIndexPlan(result) {
    for (const path of result.remove || []) taskIndex.remove(path);
    for (const file of result.put || []) {
      if (!file?.path) continue;
      if (isIndexableNote(file)) taskIndex.replace(file.path, file.content);
      else taskIndex.remove(file.path);
    }
    source.refreshDataview?.();
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
    // Routine saves stay readable to VoiceOver but off the clean note screen.
    status.classList?.toggle?.('is-alert', state !== 'saving' && state !== 'saved');
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

  function paintFormatBar() {
    const bar = doc.getElementById('format-bar');
    if (!bar) return;
    bar.hidden = Boolean(source.readOnly) || !source.hasFocus();
  }

  const source = createEditor(host, {
    onChange: rememberEdit,
    onFocus: paintFormatBar,
    onBlur() {
      flushNow();
      paintFormatBar();
    },
    onToggle: toggledTask,
    onTap: tapped,
    hydrate: hydrateEmbed,
    dataview: (query, lang) => dataviewResult(query, lang, taskIndex),
    onDataviewToggle: dataviewToggle,
    onDataviewOpen: dataviewOpen,
    onPasteFiles: (images) => insertImages(images, { pasted: true }),
  });
  Object.defineProperty(host, 'value', { configurable: true, get: () => source.value });
  // Text typed before the last note loads would be replaced by it.
  source.readOnly = true;
  paintFormatBar();
  const formatBar = doc.getElementById('format-bar');
  if (formatBar) {
    formatBar.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) event.preventDefault();
    });
    formatBar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-format]');
      if (!button || source.readOnly) return;
      const action = button.getAttribute('data-format');
      if (action === 'dismiss') {
        source.blur();
        paintFormatBar();
        return;
      }
      source.format?.(action);
    });
  }
  const imageInput = doc.getElementById('image-file');
  if (imageInput) {
    imageInput.addEventListener('change', async () => {
      const picked = [...(imageInput.files || [])];
      imageInput.value = '';
      if (picked.length) await insertImages(picked, { pasted: true });
    });
  }
  const filePreview = doc.getElementById('file-preview');
  const closeFilePreview = () => {
    if (filePreview) filePreview.hidden = true;
  };
  doc.getElementById('file-preview-close')?.addEventListener('click', closeFilePreview);
  doc.getElementById('file-preview-scrim')?.addEventListener('click', closeFilePreview);

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

  function embedPathList() {
    const seen = new Set();
    const list = [];
    const add = (path) => {
      if (!path || seen.has(path)) return;
      seen.add(path);
      list.push(path);
    };
    for (const file of files) {
      if (file && !file.trashedAt) add(file.path);
    }
    for (const path of vaultPaths || []) add(path);
    return list;
  }

  async function embedQuery(link, extra = {}) {
    const settings = await embedSettings();
    return {
      link,
      notePath: current && current.path ? current.path : '',
      repo: settings.repo,
      branch: settings.branch,
      root: settings.root,
      token: settings.token,
      fetchImpl: globalThis.fetch.bind(globalThis),
      offline: browserOffline(),
      attachmentFolderPath: ATTACHMENT_FOLDER,
      ...extra,
    };
  }

  async function loadEmbedSrc(embed) {
    const result = await loadEmbedBlob(db, await embedQuery(embed));
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
    try {
      const options = await embedQuery(link, fresh ? { fresh: true } : {});
      const result = await loadEmbedBlob(db, options);
      return { ...result, repo: options.repo || '', url: '' };
    } catch {
      return { status: 'error', reason: browserOffline() ? OFFLINE_IMAGE_REASON : "Couldn't reach GitHub (offline)" };
    }
  }

  // One load per image link per open note. Widgets are redrawn as the caret
  // moves, so they share the blob and its object URL instead of refetching.
  // A miss is not kept: the next draw asks again, after a sign-in or a pull.
  function cachedEmbed(link, fresh = false) {
    if (!fresh && embedCache.has(link)) return embedCache.get(link);
    const entry = fetchEmbed(link, fresh).then((result) => {
      if (result.status !== 'ready' && embedCache.get(link) === entry) embedCache.delete(link);
      return result;
    });
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

  function refreshEmbeds() {
    for (const node of source.embedNodes()) {
      if (node.dataset.embed && !node.querySelector('img')) hydrateEmbed(node);
    }
  }

  function retryEmbed(node) {
    if (!node || !node.isConnected) return;
    hydrateEmbed(node, true);
  }

  function showNote(note, { heading = '', line } = {}) {
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
    source.refreshDataview?.();
    if (heading) scrollToHeading(heading);
    else if (Number.isInteger(line) && line >= 0) source.scrollToLine?.(line);
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
    applyIndexPlan(result);
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
      if (!prior || (prior.kind !== 'markdown' && prior.kind !== 'binary') || !next) continue;
      const base = typeof prior.baseSha === 'string' && prior.baseSha ? prior.baseSha : (prior.remoteSha || '');
      await sync.noteRenamed({ from, to, baseSha: base, file: next });
    }
    for (const file of result.put || []) {
      if (!file || (file.kind !== 'markdown' && file.kind !== 'binary') || destinations.has(file.path)) continue;
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

  async function insertImages(blobs, { pasted = true } = {}) {
    if (!current || source.readOnly || !blobs?.length) return;
    if (!(await flushEditing())) return;
    const settings = await embedSettings();
    const existing = files.map((file) => file.path);
    const put = [];
    let tick = Date.now();
    for (const blob of blobs) {
      const bytes = await blob.arrayBuffer();
      const dest = attachmentDestination(current.path, {
        mime: blob.type || '',
        filename: blob.name || '',
        existingPaths: existing,
        pasted,
        now: new Date(tick),
      });
      tick += 1;
      existing.push(dest.path);
      const file = makeBinaryFile(dest.path, {
        bytes: bytes.byteLength,
        dirty: true,
        origin: 'user',
        now: Date.now(),
      });
      try {
        await rememberImage(db, {
          repo: settings.repo || '',
          path: dest.path,
          data: bytes,
          type: blob.type || mimeFor(dest.path),
        });
      } catch {
        // The bytes stay in memory for this insert; the next view can store them.
      }
      put.push(file);
    }
    if (!put.length) return;
    await commitFiles(db, { put });
    files.push(...put);
    for (const file of put) {
      for (const folder of ancestorFolders(file.path)) {
        if (!folders.includes(folder)) folders.push(folder);
        expanded.add(folder);
      }
    }
    await setMeta(db, 'folders', folders);
    await setMeta(db, 'expanded', [...expanded]);
    const links = put.map((file) => embedLinkFor(file.path, embedPathList())).join('\n');
    source.insert(links);
    current.content = source.value;
    current.dirty = true;
    current.updatedAt = Date.now();
    await saver.flush();
    for (const file of put) await sync?.noteEdited(file);
    renderList();
    refreshEmbeds();
  }

  function showFilePreview(path, file) {
    if (!filePreview) return;
    const name = doc.getElementById('file-preview-name');
    const size = doc.getElementById('file-preview-size');
    if (name) name.textContent = basename(path);
    if (size) size.textContent = formatByteSize(file?.bytes || 0);
    filePreview.hidden = false;
  }

  async function openAttachment(path) {
    closeSheet();
    closeFilePreview();
    const file = files.find((item) => item.path === path && !item.trashedAt)
      || extraAttachmentFiles(files, vaultPaths).find((item) => item.path === path);
    if (!file) return;
    if (isImagePath(path)) {
      const settings = await embedSettings();
      const result = await loadAttachmentBytes(db, {
        path,
        repo: settings.repo,
        branch: settings.branch,
        root: settings.root,
        token: settings.token,
        fetchImpl: globalThis.fetch.bind(globalThis),
        offline: browserOffline(),
        sha: file.remoteSha || file.baseSha || '',
      });
      if (result.status === 'ready' && result.blob) {
        const url = URL.createObjectURL(result.blob);
        viewerUrls.add(url);
        photos.open({ slides: [{ src: url, blob: result.blob, alt: basename(path) }], index: 0 });
        return;
      }
    }
    showFilePreview(path, file);
  }

  async function openPath(path, { heading = '', line } = {}) {
    if (current && current.path !== path) {
      if (!(await flushEditing())) return;
    }
    const note = files.find((item) => item.path === path && !item.trashedAt);
    if (!note) {
      setStatus('missing', path.replace(/\.md$/i, ''));
      return;
    }
    showNote(note, { heading, line });
    await setMeta(db, 'lastOpened', path);
    recent = rememberRecent(recent, path);
    await setMeta(db, 'recent', recent);
    closeSheet();
  }

  function paintSearchMode() {
    drawerPanel?.classList?.toggle?.('is-searching', searching);
    if (searchCancel) searchCancel.hidden = !searching;
    if (!searching) {
      query = '';
      if (search) search.value = '';
      if (searchOptionsPanel) searchOptionsPanel.hidden = true;
      searchOptions?.setAttribute?.('aria-expanded', 'false');
    }
  }

  function setSearching(on) {
    searching = Boolean(on);
    paintSearchMode();
    renderList();
  }

  function renderList() {
    const q = searching ? query : '';
    if (searching && !String(q || '').trim()) {
      list.replaceChildren();
    } else {
      const rows = listBrowser({
        files,
        folders,
        expanded: [...expanded],
        recent,
        query: q,
        currentPath: current ? current.path : '',
        matchCase,
        searchContent: searchContent ? searchContent.checked !== false : true,
        extraPaths: vaultPaths,
      });
      list.replaceChildren();
      for (const row of rows) list.append(renderRow(row));
    }
    if (vaultCount) vaultCount.textContent = vaultSummary(files, folders, vaultPaths).text;
  }

  async function paintVault() {
    if (vaultName) {
      const settings = await embedSettings();
      vaultName.textContent = (settings.repo || '').split('/').pop() || 'Core Sample';
    }
    try {
      const index = await getMeta(db, 'githubVaultIndex');
      vaultPaths = index && Array.isArray(index.paths) ? index.paths : null;
      const extras = extraAttachmentFiles(files, vaultPaths);
      if (extras.length) {
        const now = Date.now();
        const shas = index && index.shas ? index.shas : {};
        const sizes = index && index.sizes ? index.sizes : {};
        const stubs = extras.map((row) => fileFromRemoteAttachment({
          localPath: row.path,
          sha: shas[row.path] || '',
          size: sizes[row.path] || 0,
        }, now));
        await commitFiles(db, { put: stubs });
        files.push(...stubs);
        for (const file of stubs) {
          for (const folder of ancestorFolders(file.path)) {
            if (!folders.includes(folder)) folders.push(folder);
          }
        }
        await setMeta(db, 'folders', folders);
      }
    } catch {
      vaultPaths = null;
    }
    if (vaultCount) vaultCount.textContent = vaultSummary(files, folders, vaultPaths).text;
    renderList();
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
      if (row.type === 'attachment') openBtn.append(fileTypeIcon(row.icon));
      const name = doc.createElement('span');
      name.className = 'note-name';
      name.textContent = row.title;
      openBtn.append(name);
      if (row.detail) {
        const detail = doc.createElement('span');
        detail.className = 'note-path';
        detail.textContent = row.detail;
        openBtn.append(detail);
      }
      openBtn.addEventListener('click', () => {
        if (row.type === 'attachment') openAttachment(row.path);
        else openPath(row.path);
      });
    }
    item.className = 'browser-row';
    item.append(openBtn);
    bindRowMenu(item, row.path, row.type === 'folder' ? 'folder' : row.type === 'attachment' ? 'attachment' : 'note');
    return item;
  }

  function fileTypeIcon(kind) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('file-icon');
    if (kind === 'image') {
      svg.innerHTML = '<rect x="4.5" y="5.5" width="15" height="13" rx="2"></rect><circle cx="9" cy="10" r="1.3"></circle><path d="m8 16 3-3.2 2.2 2.2L16.5 12 19.5 16"></path>';
    } else {
      svg.innerHTML = '<path d="M7 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-10.5A1.5 1.5 0 0 1 5.5 20v-15A1.5 1.5 0 0 1 7 3.5z"></path><path d="M14 3.5V9h5.5"></path>';
    }
    return svg;
  }

  function bindRowMenu(item, path, kind) {
    const view = doc.defaultView || globalThis;
    let timer = 0;
    let start = null;
    let opened = false;

    const cancelHold = () => {
      if (timer) view.clearTimeout?.(timer);
      timer = 0;
      start = null;
    };

    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      opened = true;
      openItem(path, kind);
    });
    item.addEventListener('touchstart', (event) => {
      const touch = event.changedTouches && event.changedTouches[0];
      if (!touch) return;
      start = { x: touch.clientX, y: touch.clientY };
      opened = false;
      timer = view.setTimeout?.(() => {
        opened = true;
        openItem(path, kind);
      }, LONG_PRESS);
    }, { passive: true });
    item.addEventListener('touchmove', (event) => {
      const touch = event.changedTouches && event.changedTouches[0];
      if (!start || !touch) return;
      if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > SLOP) cancelHold();
    }, { passive: true });
    item.addEventListener('touchend', cancelHold);
    item.addEventListener('touchcancel', cancelHold);
    item.addEventListener('click', (event) => {
      if (!opened) return;
      event.preventDefault();
      event.stopPropagation();
      opened = false;
    }, true);
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
  }

  function renderBackup() {
    if (!backupBox) return;
    backupBox.replaceChildren();
    backupBox.hidden = !backupStep;
    if (backupStep?.type === 'import') renderImportPanel();
    else if (backupStep?.type === 'confirm-replace') renderReplacePanel();
  }

  function closeBackup() {
    backupStep = null;
    renderBackup();
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
    if (panel.kind !== 'attachment') {
      panelBox.append(panelButton('Rename', () => { panel = { ...panel, type: 'rename' }; renderPanel(); }));
    }
    panelBox.append(
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
    const name = panel.kind === 'folder'
      ? panel.path
      : panel.kind === 'attachment'
        ? panel.path.split('/').pop()
        : panel.path.replace(/\.md$/i, '');
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

  function renderImportPanel() {
    const count = backupStep.backup.files.length;
    const message = doc.createElement('p');
    message.textContent = `This backup has ${count} ${count === 1 ? 'note' : 'notes'}.`;
    backupBox.append(
      message,
      panelButton('Add to this device', () => addBackup(backupStep.backup)),
      panelButton('Replace notes on this device', () => {
        backupStep = { type: 'confirm-replace', backup: backupStep.backup };
        renderBackup();
      }),
      panelButton('Cancel', closeBackup),
    );
  }

  function renderReplacePanel() {
    const message = doc.createElement('p');
    message.textContent = 'Replace the notes on this device with this backup? Notes that are not in the backup will be removed. Export first if you still need them.';
    backupBox.append(message, panelButton('Replace', () => replaceBackup(backupStep.backup), 'danger'), panelButton('Cancel', closeBackup));
  }

  function backupMessage(text) {
    if (backupStatus) backupStatus.textContent = text;
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
        const moved = planRenameAttachmentFolder(result.files, result.folders || folders, panel.path, to, Date.now());
        if (moved) {
          const fromFolder = noteAttachmentFolder(panel.path);
          const toFolder = noteAttachmentFolder(to);
          result = mergePlans(result, moved);
          if (fromFolder && toFolder) remapExpanded(fromFolder, toFolder);
        }
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
    updateIndexPath(note);
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
      backupMessage("Couldn't save the open note before export.");
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
      rebuildIndex();
      folders = merged.folders;
      await setMeta(db, 'folders', folders);
      backupMessage(merged.keptAside.length
        ? `Added the backup. ${merged.keptAside.length} notes were kept beside ones already here.`
        : 'Added the backup.');
      closeBackup();
      renderList();
    } catch (error) {
      backupMessage(error.message);
    }
  }

  async function replaceBackup(backup) {
    if (!(await flushEditing())) {
      backupMessage("Couldn't save the open note.");
      return;
    }
    try {
      await commitFiles(db, {
        remove: files.map((file) => file.path),
        put: backup.files,
      });
      files = backup.files.map((file) => ({ ...file }));
      rebuildIndex();
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
      backupMessage('Replaced the notes on this device.');
      closeBackup();
      renderList();
    } catch (error) {
      backupMessage(error.message);
    }
  }

  const drawer = mountDrawer(doc, {
    beforeOpen() {
      formError.textContent = '';
      renderList();
      renderPanel();
      paintVault().catch(() => {});
      // Opening the panel puts the keyboard away, as Obsidian does.
      source.blur();
    },
    afterClose() {
      closePanel();
      if (form) form.hidden = true;
      if (searching) setSearching(false);
    },
    blocked: () => booting || overlayOpen(),
  });

  function overlayOpen() {
    return ['settings-sheet', 'conflict-sheet', 'image-viewer', 'file-preview'].some((id) => {
      const node = doc.getElementById(id);
      return node && !node.hidden;
    });
  }

  function closeSheet() {
    drawer.close();
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

  search?.addEventListener('focus', () => {
    if (!searching) setSearching(true);
  });
  search?.addEventListener('input', () => {
    query = search.value;
    if (!searching) {
      searching = true;
      paintSearchMode();
    }
    renderList();
  });
  search?.addEventListener('blur', () => {
    if (searching && !String(search.value || '').trim()) setSearching(false);
  });
  searchCancel?.addEventListener('click', () => {
    setSearching(false);
    search?.blur?.();
  });
  searchCase?.addEventListener('click', () => {
    matchCase = !matchCase;
    searchCase.setAttribute('aria-pressed', matchCase ? 'true' : 'false');
    renderList();
  });
  searchOptions?.addEventListener('click', () => {
    const open = searchOptionsPanel.hidden;
    searchOptionsPanel.hidden = !open;
    searchOptions.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  searchContent?.addEventListener('change', renderList);
  doc.getElementById('new-note-button')?.addEventListener('click', () => {
    formError.textContent = '';
    closePanel();
    form.hidden = !form.hidden;
    if (!form.hidden) nameInput.focus();
  });
  doc.getElementById('new-folder-button').addEventListener('click', () => {
    panel = { type: 'new-folder', parent: '' };
    formError.textContent = '';
    if (form) form.hidden = true;
    renderPanel();
  });
  doc.getElementById('export-backup')?.addEventListener('click', () => {
    backupMessage('');
    exportBackup().catch((error) => {
      backupMessage(error && error.message ? error.message : "Couldn't export the backup.");
    });
  });
  doc.getElementById('import-backup')?.addEventListener('click', () => {
    backupMessage('');
    backupFile.click();
  });
  backupFile.addEventListener('change', async () => {
    const chosen = backupFile.files && backupFile.files[0];
    backupFile.value = '';
    if (!chosen) return;
    try {
      backupStep = { type: 'import', backup: parseBackup(await chosen.text()) };
      backupMessage('');
      renderBackup();
    } catch (error) {
      backupMessage(error.message);
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
    updateIndexPath(note);
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

  async function dataviewToggle(task) {
    const path = task?.path;
    if (!path) return;
    const isCurrent = current && current.path === path;
    const file = isCurrent
      ? { ...snapshot(), content: source.value }
      : files.find((item) => item.path === path && !item.trashedAt);
    if (!file) {
      setStatus('invalid', 'That task is gone from its note. Nothing was changed.');
      return;
    }
    const result = applyTaskToggle(file.content, task);
    if (result.error) {
      setStatus('invalid', result.error);
      return;
    }
    if (result.content === file.content) return;
    if (isCurrent) {
      source.replaceText?.(result.content) || (source.value = result.content);
      current.content = result.content;
      current.dirty = true;
      current.updatedAt = Date.now();
      if (!source.replaceText) rememberEdit();
      taskIndex.replace(path, result.content);
      flushNow();
      source.refreshDataview?.();
      return;
    }
    const next = { ...file, content: result.content, dirty: true, updatedAt: Date.now() };
    try {
      await putFile(db, next);
    } catch {
      setStatus('error');
      return;
    }
    const at = files.findIndex((item) => item.path === path);
    if (at >= 0) files[at] = next;
    else files.push(next);
    taskIndex.replace(path, next.content);
    sync?.noteEdited(next);
    source.refreshDataview?.();
  }

  function dataviewOpen(task) {
    if (!task?.path) return;
    if (linkNav) return;
    const line = Number.isInteger(task.line) ? task.line : 0;
    linkNav = openPath(task.path, { line }).finally(() => {
      linkNav = null;
    });
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
    source.readOnly = holding || booting;
    paintFormatBar();
  }

  async function replaceFile(file) {
    await putFile(db, file);
    const index = files.findIndex((item) => item.path === file.path);
    if (index >= 0) files[index] = file;
    else files.push(file);
    updateIndexPath(file);
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
    const now = Date.now();
    const notes = plan.writes.map((note) => fileFromRemote(
      { localPath: note.localPath },
      note.content,
      note.sha,
      now,
    ));
    const taken = new Set(mode === 'replace' ? [] : files.map((file) => file.path));
    for (const note of notes) taken.add(note.path);
    const stubs = [];
    for (const entry of loaded.attachments || []) {
      if (!entry || taken.has(entry.localPath)) continue;
      stubs.push(fileFromRemoteAttachment(entry, now));
      taken.add(entry.localPath);
    }
    const writes = [...notes, ...stubs];
    if (!writes.length) {
      startImagePrefetch(db);
      return {
        downloaded: 0,
        skipped: plan.skipped.length,
        empty: loaded.length === 0 && !(loaded.attachments && loaded.attachments.length),
      };
    }
    await commitFiles(db, { put: writes, remove: plan.remove });
    applyIndexPlan({ put: writes, remove: plan.remove });
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
      expanded = new Set();
      for (const file of files) {
        if (!file || file.kind === 'binary' || file.trashedAt) continue;
        for (const folder of ancestorFolders(file.path)) expanded.add(folder);
      }
      await setMeta(db, 'folders', folders);
      await setMeta(db, 'recent', recent);
      await setMeta(db, 'expanded', [...expanded]);
    } else {
      for (const file of writes) {
        for (const folder of ancestorFolders(file.path)) {
          if (!folders.includes(folder)) folders.push(folder);
          if (file.kind !== 'binary') expanded.add(folder);
        }
      }
      await setMeta(db, 'folders', folders);
      await setMeta(db, 'expanded', [...expanded]);
    }
    syncOpen();
    renderList();
    startImagePrefetch(db);
    refreshEmbeds();
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
    taskIndex.rebuild([]);
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
      updateIndexPath(file);
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
    for (const path of gone) taskIndex.remove(path);
    source.refreshDataview?.();
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
    updateIndexPath(next);
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
    applyIndexPlan(plan);
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
        rebuildIndex();
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
    updateIndexPath(next);
    renderList();
    await sync?.refreshStatus();
  }

  sync = createAutoSync({
    db,
    fetchImpl: globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined,
    offline: () => browserOffline(),
    beforeSync: () => saver.flush(),
    onStatus: paintSync,
    onApplied: applySyncedFiles,
    onRemoved: applyRemoved,
    onPulled: () => {
      startImagePrefetch(db);
      refreshEmbeds();
    },
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
    github.open(syncAlertFocus(syncKind));
    if (syncConflicts) conflictScreen.open();
  });
  doc.getElementById('sync-conflicts')?.addEventListener('click', () => conflictScreen.open());
  doc.getElementById('sync-retry')?.addEventListener('click', () => {
    sync.runNow('manual').catch(() => {});
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
    opened: () => drawer.close(),
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
  window.addEventListener('online', () => {
    refreshEmbeds();
    sync?.online();
  });

  return {
    flush: flushNow,
    async start() {
      const session = await loadSession(db);
      files = session.files;
      folders = session.folders;
      recent = session.recent;
      expanded = new Set(session.expanded || []);
      taskIndex.rebuild(notesForIndex());
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
      booting = false;
      holdEditor(holding);
      await paintVault();
      await github.refresh();
      github.resume();
      setStatus('saved');
      await sync.start();
    },
  };
}

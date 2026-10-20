import { renderMarkdown } from './markdown.js';
import { toggleChecklist } from './checklist.js';
import { putFile, setMeta } from './db.js';
import { createDebouncedSaver } from './save.js';
import {
  loadSession,
  makeFile,
  notePathFromName,
  noteTitle,
  resolveWikilink,
} from './notes.js';

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

  let notes = [];
  let current = null;
  let mode = 'source';

  const saver = createDebouncedSaver({
    delay: SAVE_DELAY,
    write: (note) => putFile(db, note),
    onStatus: (state) => setStatus(state),
  });

  function snapshot() {
    return {
      path: current.path,
      content: current.content,
      kind: 'markdown',
      encoding: 'utf-8',
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
    };
  }

  function setStatus(state, detail) {
    if (state === 'saving') status.textContent = 'Saving…';
    else if (state === 'saved') status.textContent = 'Saved on this device';
    else if (state === 'error') status.textContent = "Couldn't save. Your text is still here.";
    else if (state === 'missing') status.textContent = `No note named ${detail}`;
    else if (state === 'ambiguous') status.textContent = `More than one note named ${detail}`;
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

  function paintPreview() {
    const scroll = preview.scrollTop;
    preview.innerHTML = renderMarkdown(source.value);
    preview.scrollTop = scroll;
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

  async function openPath(path, { heading = '' } = {}) {
    if (current && current.path !== path) {
      current.content = source.value;
      try {
        await saver.flush();
      } catch {
        // The text stays in memory and on screen. Don't switch away from it
        // if we couldn't store the edit.
        return;
      }
    }
    const note = notes.find((item) => item.path === path);
    if (!note) {
      setStatus('missing', path.replace(/\.md$/i, ''));
      return;
    }
    showNote(note, { heading });
    await setMeta(db, 'lastOpened', path);
    closeSheet();
  }

  function renderList() {
    const sorted = [...notes].sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
    list.replaceChildren();
    for (const note of sorted) {
      const item = doc.createElement('li');
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'note-link';
      if (current && note.path === current.path) button.classList.add('is-current');
      const name = doc.createElement('span');
      name.className = 'note-name';
      name.textContent = noteTitle(note);
      const meta = doc.createElement('span');
      meta.className = 'note-path';
      meta.textContent = note.path;
      button.append(name, meta);
      button.addEventListener('click', () => {
        openPath(note.path);
      });
      item.append(button);
      list.append(item);
    }
  }

  function openSheet() {
    formError.textContent = '';
    renderList();
    sheet.hidden = false;
  }

  function closeSheet() {
    sheet.hidden = true;
  }

  function rememberEdit() {
    if (!current) return;
    current.content = source.value;
    current.updatedAt = Date.now();
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

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    formError.textContent = '';
    let path;
    try {
      path = notePathFromName(nameInput.value, notes.map((note) => note.path));
    } catch (error) {
      formError.textContent = error.message;
      return;
    }
    if (current) {
      current.content = source.value;
      try {
        await saver.flush();
      } catch {
        formError.textContent = "Couldn't save the note you're editing.";
        return;
      }
    }
    const titleText = path.replace(/\.md$/i, '');
    const note = makeFile(path, `# ${titleText}\n\n`);
    try {
      await putFile(db, note);
      await setMeta(db, 'lastOpened', path);
    } catch {
      formError.textContent = "Couldn't save the new note.";
      return;
    }
    notes.push(note);
    nameInput.value = '';
    showNote(note);
    closeSheet();
    if (mode === 'source') source.focus();
  });

  preview.addEventListener('click', (event) => {
    const task = event.target.closest('[data-task-index]');
    if (task) {
      event.preventDefault();
      const index = Number(task.dataset.taskIndex);
      const next = toggleChecklist(source.value, index);
      const selStart = source.selectionStart;
      const selEnd = source.selectionEnd;
      const sourceScroll = source.scrollTop;
      const previewScroll = preview.scrollTop;
      source.value = next;
      source.selectionStart = selStart;
      source.selectionEnd = selEnd;
      source.scrollTop = sourceScroll;
      if (current) {
        current.content = next;
        current.updatedAt = Date.now();
        title.textContent = noteTitle(current);
      }
      preview.innerHTML = renderMarkdown(next);
      preview.scrollTop = previewScroll;
      saver.schedule(snapshot);
      saver.flush().catch(() => {});
      return;
    }

    const link = event.target.closest('a[data-wikilink]');
    if (!link) return;
    event.preventDefault();
    const target = link.dataset.wikilink || '';
    const heading = link.dataset.heading || '';
    const match = resolveWikilink(notes, target);
    if (match.status === 'ok') {
      openPath(match.file.path, { heading });
      return;
    }
    if (match.status === 'ambiguous') setStatus('ambiguous', target);
    else setStatus('missing', target);
  });

  function flushNow() {
    if (!current) return;
    current.content = source.value;
    saver.flush().catch(() => {});
  }

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') flushNow();
  });
  window.addEventListener('pagehide', flushNow);

  return {
    async start() {
      const session = await loadSession(db);
      notes = session.notes;
      applyMode(session.mode, { persist: false });
      showNote(session.current);
      if (session.current) {
        await setMeta(db, 'lastOpened', session.current.path);
      }
      setStatus('saved');
    },
  };
}

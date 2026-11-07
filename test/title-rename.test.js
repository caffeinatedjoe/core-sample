import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deleteDatabase, getFile, getMeta, listFiles, openDatabase, putFile, setMeta } from '../app/js/db.js';
import { makeFile } from '../app/js/notes.js';
import { mountApp } from '../app/js/view.js';
import { fakeEditorFactory } from './helpers/fake-editor.js';

function element(tag) {
  const node = {
    tag,
    id: '',
    hidden: false,
    value: '',
    textContent: '',
    className: '',
    innerHTML: '',
    style: {},
    dataset: {},
    children: [],
    parent: null,
    files: null,
    selectionStart: 0,
    selectionEnd: 0,
    scrollTop: 0,
    attrs: {},
    listeners: {},
    focused: false,
    selected: false,
  };
  node.classList = {
    add(name) {
      const parts = node.className.split(/\s+/).filter(Boolean);
      if (!parts.includes(name)) parts.push(name);
      node.className = parts.join(' ');
    },
    remove(name) {
      node.className = node.className.split(/\s+/).filter((part) => part && part !== name).join(' ');
    },
    toggle(name, force) {
      const has = node.className.split(/\s+/).includes(name);
      const on = force === undefined ? !has : Boolean(force);
      if (on) this.add(name);
      else this.remove(name);
      return on;
    },
    contains(name) {
      return node.className.split(/\s+/).includes(name);
    },
  };
  node.setAttribute = (key, value) => {
    node.attrs[key] = value;
  };
  node.getAttribute = (key) => node.attrs[key];
  node.addEventListener = (type, fn) => {
    (node.listeners[type] ||= []).push(fn);
  };
  node.append = (...kids) => {
    for (const kid of kids) {
      kid.parent = node;
      node.children.push(kid);
    }
  };
  node.replaceChildren = (...kids) => {
    node.children = [];
    if (kids.length) node.append(...kids);
  };
  node.focus = () => {
    node.focused = true;
  };
  node.select = () => {
    node.selected = true;
    node.selectionStart = 0;
    node.selectionEnd = String(node.value || '').length;
  };
  node.setSelectionRange = (start, end) => {
    node.selectionStart = start;
    node.selectionEnd = end;
  };
  node.blur = () => {
    node.focused = false;
    return Promise.all((node.listeners.blur || []).map((fn) => fn()));
  };
  node.click = () => {};
  node.querySelectorAll = () => [];
  return node;
}

function descendants(node, acc = []) {
  acc.push(node);
  for (const child of node.children || []) descendants(child, acc);
  return acc;
}

function texts(root, className) {
  return descendants(root)
    .filter((node) => node.className === className)
    .map((node) => node.textContent);
}

function page() {
  const nodes = {};
  const ids = [
    'source', 'note-title', 'save-status', 'notes-sheet', 'notes-list',
    'new-note-error', 'notes-search', 'action-panel', 'backup-file',
    'notes-button', 'notes-close', 'new-folder-button', 'new-note-button',
  ];
  for (const id of ids) {
    const node = element('div');
    node.id = id;
    nodes[id] = node;
  }
  const doc = {
    body: element('body'),
    visibilityState: 'visible',
    defaultView: { navigator: {} },
    getElementById: (id) => nodes[id],
    createElement: element,
    addEventListener() {},
  };
  return { doc, nodes };
}

async function fire(node, type, event = {}) {
  const extra = {
    preventDefault() {},
    stopPropagation() {},
    target: node,
    ...event,
  };
  for (const fn of node.listeners[type] || []) await fn(extra);
}

function titleInput(title) {
  return title.children.find((node) => node.id === 'note-title-input');
}

function watchLoads(editor) {
  let loads = 0;
  const orig = editor.load.bind(editor);
  editor.load = (text) => {
    loads += 1;
    editor.selectionStart = 0;
    editor.selectionEnd = 0;
    editor.scrollTop = 0;
    orig(text);
  };
  return () => loads;
}

async function boot() {
  globalThis.window = { addEventListener() {} };
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await putFile(db, makeFile('Welcome.md', '# Welcome\n', 1));
  await putFile(db, makeFile('Index.md', 'See [[Untitled]] and [[logs/Place]].\n', 2));
  await putFile(db, makeFile('logs/Place.md', 'in folder\n', 3));
  await putFile(db, makeFile('Field.md', 'taken\n', 4));
  await setMeta(db, 'lastOpened', 'Welcome.md');
  await setMeta(db, 'folders', ['logs']);
  await setMeta(db, 'expanded', ['logs']);
  await setMeta(db, 'seeded', true);
  const { doc, nodes } = page();
  const editors = fakeEditorFactory(element);
  const app = mountApp(doc, db, { createEditor: editors });
  await app.start();
  return { name, db, nodes, editors, app };
}

async function finish(name, db) {
  db.close();
  await deleteDatabase(name);
}

test('tapping the title renames an Untitled note and keeps the caret', async () => {
  const { name, db, nodes, editors } = await boot();
  await fire(nodes['new-note-button'], 'click');
  assert.equal(nodes['note-title'].textContent, 'Untitled');
  const editor = editors.made[0];
  editor.type('keep this');
  const loads = watchLoads(editor);
  editor.selectionStart = 2;
  editor.selectionEnd = 5;
  editor.scrollTop = 18;

  await fire(nodes['note-title'], 'click');
  const input = titleInput(nodes['note-title']);
  assert.ok(input, 'the title becomes a field');
  assert.equal(input.value, 'Untitled');
  assert.equal(input.focused, true);
  assert.equal(input.selected, true);
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, 'Untitled'.length);
  assert.equal(input.enterKeyHint, 'done');
  assert.equal(input.attrs['aria-label'], 'Note name');

  input.value = 'Field notes';
  await fire(input, 'keydown', { key: 'Enter' });

  assert.equal(titleInput(nodes['note-title']), undefined);
  assert.equal(nodes['note-title'].textContent, 'Field notes');
  assert.equal(nodes['new-note-error'].textContent, '');
  assert.equal(editor.value, 'keep this');
  assert.equal(editor.selectionStart, 2);
  assert.equal(editor.selectionEnd, 5);
  assert.equal(editor.scrollTop, 18);
  assert.equal(loads(), 0);
  assert.equal(texts(nodes['notes-list'], 'note-name').includes('Field notes'), true);
  assert.equal(texts(nodes['notes-list'], 'note-name').includes('Untitled'), false);
  assert.equal(await getMeta(db, 'lastOpened'), 'Field notes.md');

  const stored = await getFile(db, 'Field notes.md');
  assert.equal(stored.content, 'keep this');
  assert.equal(stored.dirty, true);
  assert.equal(await getFile(db, 'Untitled.md'), undefined);
  const index = await getFile(db, 'Index.md');
  assert.match(index.content, /\[\[Field notes\]\]/);
  assert.match(index.content, /\[\[logs\/Place\]\]/);

  const place = descendants(nodes['notes-list']).find((node) => node.className === 'note-name' && node.textContent === 'Place');
  await fire(place.parent, 'click');
  assert.equal(nodes['note-title'].textContent, 'Place');
  const before = loads();
  editor.selectionStart = 1;
  editor.selectionEnd = 4;
  editor.scrollTop = 7;
  await fire(nodes['note-title'], 'click');
  const folderInput = titleInput(nodes['note-title']);
  assert.equal(folderInput.value, 'Place');
  folderInput.value = 'Site';
  await folderInput.blur();
  assert.equal(loads(), before);
  assert.equal(editor.selectionStart, 1);
  assert.equal(editor.scrollTop, 7);
  assert.equal(nodes['note-title'].textContent, 'Site');
  assert.equal((await getFile(db, 'logs/Site.md')).content, 'in folder\n');
  assert.equal(await getFile(db, 'logs/Place.md'), undefined);
  assert.match((await getFile(db, 'Index.md')).content, /\[\[logs\/Site\]\]/);
  assert.equal(texts(nodes['notes-list'], 'note-name').includes('Site'), true);

  await finish(name, db);
});

test('escape, blur of an empty name, and an unchanged name restore the title', async () => {
  const { name, db, nodes, editors, app } = await boot();
  await fire(nodes['new-note-button'], 'click');
  const editor = editors.made[0];
  editor.type('stay');

  await fire(nodes['note-title'], 'click');
  let input = titleInput(nodes['note-title']);
  input.value = 'Renamed';
  await fire(input, 'keydown', { key: 'Escape' });
  assert.equal(titleInput(nodes['note-title']), undefined);
  assert.equal(nodes['note-title'].textContent, 'Untitled');
  assert.equal((await listFiles(db)).some((file) => file.path === 'Renamed.md'), false);

  await fire(nodes['note-title'], 'click');
  input = titleInput(nodes['note-title']);
  input.value = '   ';
  await input.blur();
  assert.equal(nodes['note-title'].textContent, 'Untitled');
  assert.equal(nodes['new-note-error'].textContent, '');

  await fire(nodes['note-title'], 'click');
  input = titleInput(nodes['note-title']);
  input.value = '';
  await input.blur();
  assert.equal(nodes['note-title'].textContent, 'Untitled');

  await fire(nodes['note-title'], 'click');
  input = titleInput(nodes['note-title']);
  input.value = 'Untitled.md';
  await fire(input, 'keydown', { key: 'Enter' });
  assert.equal(nodes['note-title'].textContent, 'Untitled');
  assert.equal(titleInput(nodes['note-title']), undefined);
  assert.equal(editor.value, 'stay');
  await app.flush();
  assert.equal((await getFile(db, 'Untitled.md')).content, 'stay');

  await finish(name, db);
});

test('a title rename that collides keeps the field and shows the rename error', async () => {
  const { name, db, nodes } = await boot();
  await fire(nodes['new-note-button'], 'click');
  await fire(nodes['note-title'], 'click');
  const input = titleInput(nodes['note-title']);
  input.value = 'Field';
  await input.blur();

  assert.equal(input.value, 'Field');
  assert.equal(titleInput(nodes['note-title']), input);
  assert.equal(nodes['new-note-error'].textContent, 'A note with that name already exists.');
  assert.equal(nodes['save-status'].textContent, 'A note with that name already exists.');
  assert.equal(nodes['save-status'].classList.contains('is-alert'), true);
  assert.equal(await getFile(db, 'Untitled.md') !== null, true);
  assert.equal((await getFile(db, 'Field.md')).content, 'taken\n');

  await fire(input, 'keydown', { key: 'Escape' });
  assert.equal(nodes['note-title'].textContent, 'Untitled');
  assert.equal(nodes['new-note-error'].textContent, '');
  assert.equal(nodes['save-status'].textContent, 'Saved on this device');
  assert.equal(nodes['save-status'].classList.contains('is-alert'), false);

  await finish(name, db);
});

test('a title rename rejects a slash or backslash and leaves the note in place', async () => {
  const { name, db, nodes } = await boot();
  await fire(nodes['new-note-button'], 'click');

  for (const bad of ['a/b', 'a\\b']) {
    await fire(nodes['note-title'], 'click');
    const input = titleInput(nodes['note-title']);
    input.value = bad;
    await fire(input, 'keydown', { key: 'Enter' });
    assert.equal(input.value, bad);
    assert.equal(titleInput(nodes['note-title']), input);
    assert.equal(nodes['new-note-error'].textContent, 'Use a name without slashes.');
    assert.equal(nodes['save-status'].textContent, 'Use a name without slashes.');
    assert.equal(await getFile(db, 'Untitled.md') !== null, true);
    assert.equal((await listFiles(db)).some((file) => file.path.includes('a/b') || file.path.includes('a\\b')), false);
    await fire(input, 'keydown', { key: 'Escape' });
    assert.equal(nodes['note-title'].textContent, 'Untitled');
  }

  await finish(name, db);
});

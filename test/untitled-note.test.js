import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deleteDatabase, getFile, openDatabase, putFile, setMeta } from '../app/js/db.js';
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
    files: null,
    selectionStart: 0,
    selectionEnd: 0,
    scrollTop: 0,
    attrs: {},
    listeners: {},
  };
  node.classList = {
    add(name) {
      node.className = `${node.className} ${name}`.trim();
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
    node.children.push(...kids);
  };
  node.replaceChildren = (...kids) => {
    node.children = kids;
  };
  node.focus = () => {};
  node.select = () => {};
  node.click = () => {};
  node.querySelectorAll = () => [];
  return node;
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

async function click(node) {
  for (const fn of node.listeners.click || []) {
    await fn({ target: node, preventDefault() {} });
  }
}

test('new-note control creates an empty Untitled file and opens it', async () => {
  globalThis.window = { addEventListener() {} };
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await putFile(db, makeFile('Welcome.md', '# Welcome\n\nHello\n', 1));
  await setMeta(db, 'lastOpened', 'Welcome.md');
  await setMeta(db, 'seeded', true);

  const { doc, nodes } = page();
  const editors = fakeEditorFactory(element);
  const app = mountApp(doc, db, { createEditor: editors });
  await app.start();

  await click(nodes['new-note-button']);
  assert.equal(nodes['note-title'].textContent, 'Untitled');
  assert.equal(editors.made[0].value, '');
  const first = await getFile(db, 'Untitled.md');
  assert.equal(first.content, '');
  assert.equal(first.dirty, true);
  assert.equal(first.origin, 'user');

  await click(nodes['new-note-button']);
  assert.equal(nodes['note-title'].textContent, 'Untitled 1');
  assert.equal(editors.made[0].value, '');
  const second = await getFile(db, 'Untitled 1.md');
  assert.equal(second.content, '');
  assert.equal(second.path, 'Untitled 1.md');

  db.close();
  await deleteDatabase(name);
});

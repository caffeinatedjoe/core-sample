import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deleteDatabase, listFiles, openDatabase, putFile, setMeta } from '../app/js/db.js';
import { makeFile } from '../app/js/notes.js';
import { mountApp } from '../app/js/view.js';

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

function descendants(node, acc = []) {
  acc.push(node);
  for (const child of node.children || []) descendants(child, acc);
  return acc;
}

function find(root, pred) {
  return descendants(root).find(pred);
}

function texts(root, className) {
  return descendants(root)
    .filter((node) => node.className === className)
    .map((node) => node.textContent);
}

async function clickText(root, label) {
  const button = find(root, (node) => node.tag === 'button' && node.textContent === label);
  assert.ok(button, label);
  for (const fn of button.listeners.click || []) {
    await fn({ target: button, preventDefault() {} });
  }
}

function page() {
  const nodes = {};
  const ids = [
    'source', 'preview', 'note-title', 'save-status', 'notes-sheet', 'notes-list',
    'new-note-form', 'new-note-name', 'new-note-error', 'mode-source', 'mode-preview',
    'notes-search', 'action-panel', 'backup-file', 'notes-button', 'notes-close',
    'new-folder-button', 'backup-button',
  ];
  for (const id of ids) {
    const node = element(id === 'source' ? 'textarea' : 'div');
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

test('renaming from the list replaces the visible name and the stored path', async () => {
  globalThis.window = { addEventListener() {} };
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await putFile(db, makeFile('Welcome.md', '# Welcome\n\nHello\n', 1));
  await putFile(db, makeFile('logs/Field notes.md', '# Field notes\n\nSee [[Welcome]]\n', 2));
  await setMeta(db, 'lastOpened', 'Welcome.md');
  await setMeta(db, 'folders', ['logs']);
  await setMeta(db, 'expanded', ['logs']);
  await setMeta(db, 'recent', ['Welcome.md', 'logs/Field notes.md']);

  const { doc, nodes } = page();
  const app = mountApp(doc, db);
  await app.start();
  assert.equal(nodes['note-title'].textContent, 'Welcome');

  for (const fn of nodes['notes-button'].listeners.click) await fn();
  const list = nodes['notes-list'];
  const welcome = list.children.find((row) => texts(row, 'note-name').includes('Welcome'));
  assert.ok(welcome, 'the list shows Welcome before rename');
  await clickText(welcome, 'Edit');
  await clickText(nodes['action-panel'], 'Rename');
  const input = find(nodes['action-panel'], (node) => node.tag === 'input');
  assert.equal(input.value, 'Welcome');
  input.value = 'Start';
  await clickText(nodes['action-panel'], 'Save');

  assert.equal(nodes['new-note-error'].textContent, '');
  assert.equal(nodes['note-title'].textContent, 'Start');
  assert.equal(texts(list, 'note-name').includes('Welcome'), false);
  assert.equal(texts(list, 'note-name').includes('Start'), true);
  assert.equal(texts(list, 'note-path').includes('Welcome.md'), false);
  assert.equal(texts(list, 'note-path').includes('Start.md'), true);
  assert.equal(texts(list, 'note-path').includes('logs/Field notes.md'), true);

  nodes['notes-search'].value = 'Start';
  for (const fn of nodes['notes-search'].listeners.input) fn();
  assert.equal(texts(list, 'note-name').includes('Start'), true);
  assert.equal(texts(list, 'note-path').includes('Start.md'), true);
  assert.equal(texts(list, 'note-path').includes('Welcome.md'), false);
  assert.equal(texts(list, 'note-name').includes('Welcome'), false);
  nodes['notes-search'].value = 'Welcome';
  for (const fn of nodes['notes-search'].listeners.input) fn();
  assert.equal(texts(list, 'note-name').includes('Welcome'), false);
  assert.equal(texts(list, 'note-name').includes('Start'), false);

  nodes['notes-search'].value = '';
  for (const fn of nodes['notes-search'].listeners.input) fn();
  const field = list.children.find((row) => texts(row, 'note-path').includes('logs/Field notes.md'));
  await clickText(field, 'Edit');
  await clickText(nodes['action-panel'], 'Move');
  await clickText(nodes['action-panel'], 'Notes');

  assert.equal(nodes['new-note-error'].textContent, '');
  assert.equal(nodes['note-title'].textContent, 'Start');
  assert.equal(texts(list, 'note-name').filter((item) => item === 'Field notes').length > 0, true);
  assert.equal(texts(list, 'note-path').includes('logs/Field notes.md'), false);
  assert.equal(texts(list, 'note-path').includes('Field notes.md'), true);
  assert.equal(texts(list, 'note-path').includes('Start.md'), true);
  assert.equal(texts(list, 'note-name').includes('Welcome'), false);

  db.close();
  const again = await openDatabase(name);
  const stored = await listFiles(again);
  const paths = stored.map((file) => file.path).sort();
  assert.deepEqual(paths, ['Field notes.md', 'Start.md']);
  const start = stored.find((file) => file.path === 'Start.md');
  assert.match(start.content, /^# Start\n/);
  const moved = stored.find((file) => file.path === 'Field notes.md');
  assert.match(moved.content, /^# Field notes\n/);
  assert.match(moved.content, /\[\[Start\]\]/);
  assert.equal(moved.content.includes('[[Welcome]]'), false);
  again.close();
  await deleteDatabase(name);
});

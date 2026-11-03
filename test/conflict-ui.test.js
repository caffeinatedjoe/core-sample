import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountConflictScreen } from '../app/js/conflict-ui.js';
function el(tag) {
  const node = {
    tag,
    id: '',
    hidden: false,
    disabled: false,
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    dataset: {},
    attrs: {},
    children: [],
    parentNode: null,
    nextSibling: null,
    listeners: {},
  };
  node.classList = {
    add(name) { node.className = `${node.className} ${name}`.trim(); },
    remove(name) { node.className = node.className.split(/\s+/).filter((item) => item && item !== name).join(' '); },
  };
  node.setAttribute = (key, value) => { node.attrs[key] = value; };
  node.getAttribute = (key) => node.attrs[key];
  node.removeAttribute = (key) => { delete node.attrs[key]; };
  node.addEventListener = (type, fn) => { (node.listeners[type] ||= []).push(fn); };
  node.append = (...kids) => {
    for (const kid of kids) {
      if (kid && typeof kid === 'object') {
        kid.parentNode = node;
        node.children.push(kid);
      } else {
        node.textContent += String(kid ?? '');
      }
    }
  };
  node.scrollIntoView = () => {};
  node.replaceChildren = (...kids) => {
    node.children = [];
    node.append(...kids);
  };
  node.remove = () => {
    if (!node.parentNode) return;
    node.parentNode.children = node.parentNode.children.filter((item) => item !== node);
    node.parentNode = null;
  };
  node.querySelector = (sel) => walk(node, sel);
  node.querySelectorAll = (sel) => {
    const found = [];
    visit(node, (item) => {
      if (match(item, sel)) found.push(item);
    });
    return found;
  };
  return node;
}

function match(node, sel) {
  if (sel.startsWith('#')) return node.id === sel.slice(1);
  if (sel.startsWith('.')) return node.className.split(/\s+/).includes(sel.slice(1));
  if (sel.includes(',')) return sel.split(',').some((part) => match(node, part.trim()));
  return node.tag === sel;
}

function visit(node, fn) {
  fn(node);
  for (const child of node.children || []) visit(child, fn);
}

function walk(node, sel) {
  let found = null;
  visit(node, (item) => {
    if (!found && match(item, sel)) found = item;
  });
  return found;
}

function page() {
  const nodes = {};
  const ids = [
    'conflict-sheet', 'conflict-list-view', 'conflict-resolve-view', 'conflict-heading',
    'conflict-close', 'conflict-back', 'conflict-resolve-bar', 'conflict-step-bar',
    'undo-toast', 'undo-toast-text', 'undo-toast-action',
  ];
  for (const id of ids) {
    nodes[id] = el('div');
    nodes[id].id = id;
  }
  nodes['conflict-sheet'].hidden = true;
  nodes['undo-toast'].hidden = true;
  const card = el('div');
  card.className = 'sheet-card';
  nodes['conflict-sheet'].append(card);
  const home = el('div');
  home.append(nodes['undo-toast']);
  const doc = {
    defaultView: { setTimeout: () => 1, navigator: { onLine: true } },
    body: el('body'),
    activeElement: null,
    getElementById: (id) => nodes[id] || null,
    createElement: el,
    createTextNode: (text) => {
      const node = el('#text');
      node.textContent = String(text ?? '');
      return node;
    },
    querySelector: (sel) => {
      if (sel === '.sheet-card') return card;
      return nodes[sel.replace('#', '')] || null;
    },
  };
  nodes['conflict-sheet'].querySelector = (sel) => (sel === '.sheet-card' ? card : walk(nodes['conflict-sheet'], sel));
  return { doc, nodes, card };
}

function note(path, content, extra = {}) {
  return {
    path,
    content,
    kind: 'markdown',
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1,
    trashedAt: null,
    dirty: true,
    conflict: true,
    conflictCopy: false,
    conflictRemote: extra.conflictRemote || '',
    conflictRemoteKnown: true,
    conflictCopyPath: extra.conflictCopyPath || '',
    ...extra,
  };
}

function click(node, id) {
  const target = typeof id === 'string' ? walk(node, `#${id}`) || (node.id === id ? node : null) : id;
  assert.ok(target, id);
  for (const fn of target.listeners.click || []) fn({ target, preventDefault() {} });
}

function textOf(node) {
  const parts = [];
  visit(node, (item) => {
    if (item.textContent) parts.push(item.textContent);
  });
  return parts.join('\n');
}

test('Keep GitHub names this resolve’s copy after an earlier offer was left unanswered', async () => {
  const stamp = '2026-10-21 1918';
  let files = ['Alpha', 'Beta'].flatMap((name) => [
    note(`Notes/${name}.md`, `phone ${name}\n`, {
      conflictRemote: `github ${name}\n`,
      conflictCopyPath: `Notes/${name} (conflict ${stamp}).md`,
    }),
    note(`Notes/${name} (conflict ${stamp}).md`, `github ${name}\n`, {
      conflict: false,
      conflictCopy: true,
      conflictRemote: '',
      conflictRemoteKnown: false,
    }),
  ]);
  const { doc, nodes } = page();
  const screen = mountConflictScreen(doc, {
    files: () => files,
    async apply(plan) {
      const removed = new Set(plan.remove || []);
      files = files.filter((file) => !removed.has(file.path));
      for (const file of plan.put || []) {
        const index = files.findIndex((item) => item.path === file.path);
        if (index >= 0) files[index] = file;
        else files.push(file);
      }
      return { async undo() {} };
    },
    async dismiss(path) {
      const index = files.findIndex((item) => item.path === path);
      if (index >= 0) files[index] = { ...files[index], trashedAt: Date.now() };
    },
  });

  screen.open();
  const firstOpen = nodes['conflict-list-view'].querySelectorAll('.conflict-open')[0];
  await firstOpen.listeners.click[0]();
  click(nodes['conflict-resolve-view'], 'keep-github');
  const firstResolve = walk(nodes['conflict-resolve-bar'], '#conflict-resolve-button');
  await firstResolve.listeners.click[0]();
  const firstOffer = walk(nodes['conflict-list-view'], '.conflict-offer-text');
  assert.match(firstOffer.textContent, /Notes\/Alpha \(conflict 2026-10-21 1918\)\.md/);

  const betaOpen = nodes['conflict-list-view'].querySelectorAll('.conflict-open').find((btn) => (
    textOf(btn).includes('Notes/Beta.md')
  ));
  assert.ok(betaOpen, 'Beta is still in the list');
  await betaOpen.listeners.click[0]();
  click(nodes['conflict-resolve-view'], 'keep-github');
  const secondResolve = walk(nodes['conflict-resolve-bar'], '#conflict-resolve-button');
  await secondResolve.listeners.click[0]();
  const offer = walk(nodes['conflict-list-view'], '.conflict-offer-text');
  assert.match(offer.textContent, /Notes\/Beta \(conflict 2026-10-21 1918\)\.md/);
  assert.equal(/Alpha/.test(offer.textContent), false, offer.textContent);
});

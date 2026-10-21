import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deleteDatabase, openDatabase, putFile, setMeta } from '../app/js/db.js';
import { saveGithubSession, saveGithubTarget } from '../app/js/github-store.js';
import { rememberImage } from '../app/js/images.js';
import { makeFile } from '../app/js/notes.js';
import { mountApp } from '../app/js/view.js';

const TOKEN = 'gho_testtokenvalue123456';
const NOTE = 'Field Notes.md';
const LINK = 'image-1710000000000.png';

function matches(node, selector) {
  const classes = String(node.className || '').split(/\s+/).filter(Boolean);
  if (selector === '[data-embed]') return Boolean(node.dataset.embed);
  if (selector === 'img' || selector === 'img.embed-image' || selector === '.embed-image') {
    return node.tag === 'img' && (selector === 'img' || classes.includes('embed-image'));
  }
  if (selector === '.embed' || selector === '.embed[data-embed]') {
    return classes.includes('embed') && (selector === '.embed' || Boolean(node.dataset.embed));
  }
  if (selector === '.embed-fallback') return classes.includes('embed-fallback');
  if (selector === '[data-wikilink]') return Boolean(node.dataset.wikilink);
  if (selector === '[data-task-index]') return node.dataset.taskIndex != null && node.dataset.taskIndex !== '';
  if (selector === 'a[href]') return node.tag === 'a' && Boolean(node.attrs.href);
  return false;
}

function element(tag = 'div') {
  const node = {
    tag,
    nodeType: 1,
    id: '',
    hidden: false,
    value: '',
    textContent: '',
    className: '',
    type: '',
    style: {},
    dataset: {},
    children: [],
    parent: null,
    isConnected: true,
    attrs: {},
    listeners: {},
    files: null,
    selectionStart: 0,
    selectionEnd: 0,
    scrollTop: 0,
    readOnly: false,
  };
  node.classList = {
    add(name) {
      node.className = `${node.className} ${name}`.trim();
    },
    contains(name) {
      return node.className.split(/\s+/).includes(name);
    },
  };
  node.setAttribute = (key, value) => {
    node.attrs[key] = String(value);
    if (key === 'data-embed') node.dataset.embed = String(value);
  };
  node.getAttribute = (key) => (Object.prototype.hasOwnProperty.call(node.attrs, key) ? node.attrs[key] : null);
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
  node.closest = (selector) => {
    let current = node;
    while (current) {
      if (matches(current, selector)) return current;
      current = current.parent;
    }
    return null;
  };
  node.querySelectorAll = (selector) => descendants(node).filter((item) => item !== node && matches(item, selector));
  node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null;
  node.focus = () => {};
  return node;
}

function descendants(node, acc = []) {
  acc.push(node);
  for (const child of node.children || []) descendants(child, acc);
  return acc;
}

function page() {
  const ids = [
    'source', 'preview', 'note-title', 'save-status', 'notes-sheet', 'notes-list',
    'new-note-form', 'new-note-name', 'new-note-error', 'mode-source', 'mode-preview',
    'notes-search', 'action-panel', 'backup-file', 'notes-button', 'notes-close',
    'new-folder-button', 'backup-button',
  ];
  const nodes = {};
  for (const id of ids) {
    const node = element(id === 'source' ? 'textarea' : 'div');
    node.id = id;
    nodes[id] = node;
  }
  const preview = nodes.preview;
  let html = '';
  Object.defineProperty(preview, 'innerHTML', {
    get() {
      return html;
    },
    set(value) {
      html = String(value);
      preview.children = [];
      const found = html.matchAll(/data-embed="([^"]*)"/g);
      for (const match of found) {
        const embed = element('span');
        embed.className = 'embed';
        embed.dataset.embed = match[1];
        embed.attrs['data-embed'] = match[1];
        preview.append(embed);
      }
    },
  });
  const doc = {
    body: element('body'),
    visibilityState: 'visible',
    defaultView: { navigator: {}, addEventListener() {} },
    getElementById: (id) => nodes[id] || null,
    createElement: (tag) => element(tag),
    addEventListener() {},
  };
  return { doc, nodes };
}

function chipText(preview) {
  const button = preview.querySelector('.embed-fallback');
  return button ? button.textContent : '';
}

async function until(read) {
  for (let i = 0; i < 40; i += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return '';
}

function githubFetch(mode) {
  const urls = [];
  const fetchImpl = async (url) => {
    const text = String(url);
    urls.push(text);
    if (text.includes(TOKEN)) throw new Error('token leaked into the url');
    if (mode === 'offline') throw new Error('socket closed');
    if (mode === '401') return new Response('{"message":"Bad credentials"}', { status: 401 });
    if (mode === '404') return new Response('{"message":"Not Found"}', { status: 404 });
    if (text.includes('/git/trees/')) {
      return new Response(JSON.stringify({
        sha: 'tree123',
        truncated: false,
        tree: [{ path: NOTE, type: 'blob' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('missing', { status: 404 });
  };
  return { urls, fetchImpl };
}

async function openPreview(db, fetchImpl, { offline = false } = {}) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  globalThis.window = { addEventListener() {} };
  const { doc, nodes } = page();
  doc.defaultView.navigator.onLine = !offline;
  const app = mountApp(doc, db);
  await app.start();
  const text = await until(() => chipText(nodes.preview));
  return {
    nodes,
    text,
    restore() {
      globalThis.fetch = previous;
    },
  };
}

async function seeded(db, { token = TOKEN } = {}) {
  await putFile(db, makeFile(NOTE, `![[${LINK}]]\n`, 1));
  await setMeta(db, 'lastOpened', NOTE);
  await setMeta(db, 'editorMode', 'preview');
  await saveGithubTarget(db, { repo: 'owner/repo', branch: 'main', root: '' });
  if (token) await saveGithubSession(db, { token });
}

test('the preview chip names a sign-in, access, or reach failure', async () => {
  const cases = [
    ['401', "Couldn't reach GitHub (HTTP 401)"],
    ['404', 'No access to repo'],
    ['offline', 'Not downloaded yet (offline)'],
    ['missing', 'Not found in vault'],
  ];
  for (const [mode, reason] of cases) {
    const name = `core-sample-${randomUUID()}`;
    const db = await openDatabase(name);
    const github = githubFetch(mode);
    github.fetchImpl.urls = github.urls;
    try {
      await seeded(db);
      const shown = await openPreview(db, github.fetchImpl);
      try {
        assert.equal(shown.text, reason, mode);
        assert.equal(shown.text.includes(TOKEN), false, mode);
        assert.equal(github.urls.some((url) => url.includes(TOKEN)), false, mode);
        const before = github.urls.length;
        const button = shown.nodes.preview.querySelector('.embed-fallback');
        assert.equal(button.tag, 'button', mode);
        for (const fn of shown.nodes.preview.listeners.click || []) {
          await fn({ target: button, preventDefault() {} });
        }
        const grew = await until(() => (github.urls.length > before ? 'yes' : ''));
        assert.equal(grew, 'yes', `${mode} retry`);
        const retried = chipText(shown.nodes.preview);
        assert.equal(retried, reason, `${mode} retry`);
      } finally {
        shown.restore();
      }
    } finally {
      db.close();
      await deleteDatabase(name);
    }
  }

  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const github = githubFetch('401');
  github.fetchImpl.urls = github.urls;
  try {
    await seeded(db, { token: '' });
    const shown = await openPreview(db, github.fetchImpl);
    try {
      assert.equal(shown.text, 'Sign in again');
      assert.equal(shown.text.includes(TOKEN), false);
      assert.equal(github.urls.length, 0);
    } finally {
      shown.restore();
    }
  } finally {
    db.close();
    await deleteDatabase(name);
  }
});

test('a saved image has no chip offline, and a true miss does not ask for sign-in', async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const image = 'assets/Field Notes/image-1710000000000.png';
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const github = githubFetch('offline');
  github.fetchImpl.urls = github.urls;
  try {
    await seeded(db);
    await rememberImage(db, {
      repo: 'owner/repo',
      path: image,
      blob: new Blob([png], { type: 'image/png' }),
      type: 'image/png',
      sha: 'sha-field',
    });
    await setMeta(db, 'githubResolvedEmbeds', {
      repo: 'owner/repo',
      branch: 'main',
      root: '',
      links: {
        [`${NOTE}\n${LINK}`]: image,
        [`path\n${image}`]: image,
      },
    });
    await setMeta(db, 'githubVaultIndex', {
      repo: 'owner/repo',
      branch: 'main',
      root: '',
      paths: [NOTE],
      attachmentFolderPath: '',
      fetchedAt: 1,
      treeSha: 'stale',
      truncated: false,
      shas: {},
    });
    const shown = await openPreview(db, github.fetchImpl);
    try {
      const img = await until(() => (shown.nodes.preview.querySelector('img.embed-image') ? 'yes' : ''));
      assert.equal(img, 'yes');
      assert.equal(chipText(shown.nodes.preview), '');
      assert.equal(github.urls.length, 0);
      assert.equal(shown.nodes.preview.textContent.includes('Sign in again'), false);
    } finally {
      shown.restore();
    }
  } finally {
    db.close();
    await deleteDatabase(name);
  }

  const missingName = `core-sample-${randomUUID()}`;
  const missingDb = await openDatabase(missingName);
  const missingGithub = githubFetch('offline');
  missingGithub.fetchImpl.urls = missingGithub.urls;
  try {
    await seeded(missingDb);
    const shown = await openPreview(missingDb, missingGithub.fetchImpl, { offline: true });
    try {
      const text = await until(() => chipText(shown.nodes.preview));
      assert.equal(text, 'Not downloaded yet (offline)');
      assert.equal(text.includes('Sign in again'), false);
      assert.equal(missingGithub.urls.length, 0);
      const button = shown.nodes.preview.querySelector('.embed-fallback');
      for (const fn of shown.nodes.preview.listeners.click || []) {
        await fn({ target: button, preventDefault() {} });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(missingGithub.urls.length, 0);
      assert.equal(chipText(shown.nodes.preview), 'Not downloaded yet (offline)');
    } finally {
      shown.restore();
    }
  } finally {
    missingDb.close();
    await deleteDatabase(missingName);
  }
});

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deleteDatabase, openDatabase } from '../app/js/db.js';
import { DEVICE_PAGE } from '../app/js/github-device.js';
import { mountGithub } from '../app/js/github-ui.js';
import {
  loadGithubSettings,
  loadPendingFlow,
  saveGithubConfig,
  savePendingFlow,
} from '../app/js/github-store.js';

const TOKEN = 'gho_testtokenvalue123456';
const DEVICE = 'dc_supersecretvalue';
const USER_CODE = 'ABCD-1234';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function element(id) {
  const node = {
    id,
    hidden: false,
    value: '',
    textContent: '',
    href: '',
    target: '',
    rel: '',
    focused: false,
    scrolled: false,
    listeners: {},
  };
  node.addEventListener = (type, fn) => {
    (node.listeners[type] ||= []).push(fn);
  };
  node.focus = () => {
    node.focused = true;
  };
  node.scrollIntoView = () => {
    node.scrolled = true;
  };
  node.click = () => {
    for (const fn of node.listeners.click || []) fn({ target: node, preventDefault() {} });
  };
  node.setAttribute = () => {};
  return node;
}

function page(fetchImpl) {
  const ids = [
    'github-sheet', 'github-client-id', 'github-relay', 'github-repo', 'github-branch', 'github-root',
    'github-status', 'github-device', 'github-signin-state', 'github-user-code', 'github-verify',
    'github-try-again', 'github-target', 'github-login', 'github-choice', 'github-confirm-replace',
    'github-disconnect-confirm', 'github-erase-confirm', 'github-connect', 'github-file-bar',
    'github-file-status', 'github-button', 'github-close', 'github-save-config', 'github-open-github',
    'github-check-now', 'github-cancel', 'github-save-repo', 'github-download', 'github-alongside',
    'github-export-replace', 'github-disconnect', 'github-disconnect-yes', 'github-erase',
    'github-erase-yes', 'github-push', 'github-pull',
  ];
  const nodes = {};
  for (const id of ids) nodes[id] = element(id);
  for (const id of ['github-sheet', 'github-device', 'github-try-again', 'github-target', 'github-choice', 'github-confirm-replace', 'github-disconnect-confirm', 'github-erase-confirm', 'github-file-bar']) {
    nodes[id].hidden = true;
  }
  nodes['github-verify'].href = DEVICE_PAGE;
  const opens = [];
  const copies = [];
  const doc = {
    visibilityState: 'visible',
    listeners: {},
    body: element('body'),
    getElementById: (id) => nodes[id],
    addEventListener(type, fn) {
      (doc.listeners[type] ||= []).push(fn);
    },
    dispatch(type) {
      for (const fn of doc.listeners[type] || []) fn({ type });
    },
  };
  const view = {
    listeners: {},
    navigator: {
      clipboard: {
        writeText(text) {
          copies.push(text);
          return view.copyResult(text);
        },
      },
    },
    copyResult: () => Promise.resolve(),
    open(url) {
      opens.push(url);
      return view.openResult;
    },
    openResult: {},
    fetch: fetchImpl,
    setTimeout,
    addEventListener(type, fn) {
      (view.listeners[type] ||= []).push(fn);
    },
    dispatch(type) {
      for (const fn of view.listeners[type] || []) fn({ type, persisted: true });
    },
  };
  doc.defaultView = view;
  return { doc, nodes, view, opens, copies };
}

function domText(nodes) {
  return Object.values(nodes).map((node) => [node.textContent, node.value, node.href].join('\n')).join('\n');
}

async function until(read) {
  for (let i = 0; i < 30; i += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out');
}

test('a pending sign-in survives a reload, then the repo field is shown and focused', async () => {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args);
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const urls = [];
  try {
    const first = page(async (url, options) => {
      urls.push(String(url));
      assert.equal(String(url).includes(DEVICE), false);
      assert.equal(String(options?.body || '').includes('verification_uri_complete'), false);
      return jsonResponse({
        user_code: USER_CODE,
        device_code: DEVICE,
        interval: 5,
        expires_in: 90,
        verification_uri: DEVICE_PAGE,
        verification_uri_complete: `${DEVICE_PAGE}?user_code=${USER_CODE}`,
      });
    });
    mountGithub(first.doc, db, {
      now: () => 1_000,
      sleep: () => new Promise(() => {}),
    });
    first.nodes['github-client-id'].value = 'Iv1.public';
    first.nodes['github-relay'].value = 'https://relay.example/device/code';
    first.nodes['github-connect'].click();
    const pending = await until(() => loadPendingFlow(db));
    assert.equal(pending.deviceCode, DEVICE);
    assert.equal(pending.userCode, USER_CODE);
    assert.equal(pending.interval, 5);
    assert.equal(pending.expiresAt, 1_000 + 90_000);
    assert.equal(domText(first.nodes).includes(DEVICE), false);
    assert.equal(first.nodes['github-signin-state'].textContent, 'Finishing sign-in…');
    assert.equal(first.nodes['github-user-code'].textContent, USER_CODE);

    const secondUrls = [];
    const second = page(async (url) => {
      secondUrls.push(String(url));
      assert.equal(String(url).includes(DEVICE), false);
      assert.equal(String(url).includes(TOKEN), false);
      if (String(url).endsWith('/oauth/access_token')) return jsonResponse({ access_token: TOKEN });
      if (String(url) === 'https://api.github.com/user') return jsonResponse({ login: 'octocat' });
      return jsonResponse({ message: 'nope' }, 404);
    });
    const resumed = mountGithub(second.doc, db, {
      now: () => 1_000,
      sleep: () => Promise.resolve(),
    });
    resumed.resume();
    await until(() => second.nodes['github-repo'].focused);
    assert.equal(await loadPendingFlow(db), null);
    assert.equal(second.nodes['github-target'].hidden, false);
    assert.equal(second.nodes['github-sheet'].hidden, false);
    assert.equal(second.nodes['github-repo'].focused, true);
    assert.equal(second.nodes['github-repo'].scrolled, true);
    assert.equal(second.nodes['github-device'].hidden, true);
    assert.equal(second.nodes['github-status'].textContent, 'Signed in as octocat.');
    assert.equal(domText(second.nodes).includes(DEVICE), false);
    assert.equal(domText(second.nodes).includes(TOKEN), false);
    assert.equal(secondUrls.some((url) => url.includes(DEVICE) || url.includes(TOKEN)), false);
    assert.equal(logs.length, 0);
  } finally {
    console.log = original;
    db.close();
    await deleteDatabase(name);
  }
});

test('visibility, pageshow, and a second resume share one poll loop', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await saveGithubConfig(db, { clientId: 'Iv1.public', relay: 'https://relay.example' });
  await savePendingFlow(db, {
    deviceCode: DEVICE,
    userCode: USER_CODE,
    interval: 5,
    expiresAt: 50_000,
  });
  let active = 0;
  let maxActive = 0;
  let posts = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { doc, nodes, view } = page(async (url) => {
    if (String(url).endsWith('/oauth/access_token')) {
      posts += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return jsonResponse({ access_token: TOKEN });
    }
    return jsonResponse({ login: 'octocat' });
  });
  const app = mountGithub(doc, db, {
    now: () => 1_000,
    sleep: () => Promise.resolve(),
  });
  const first = app.resume();
  app.resume();
  await until(() => posts > 0);
  doc.visibilityState = 'visible';
  doc.dispatch('visibilitychange');
  view.dispatch('pageshow');
  nodes['github-check-now'].click();
  app.resume();
  assert.equal(posts, 1);
  assert.equal(maxActive, 1);
  release();
  await first;
  assert.equal(await loadPendingFlow(db), null);
  assert.equal(nodes['github-repo'].focused, true);
  assert.equal(domText(nodes).includes(DEVICE), false);
  db.close();
  await deleteDatabase(name);
});

test('an expired or declined flow is cleared and offers Try again', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await saveGithubConfig(db, { clientId: 'Iv1.public', relay: 'https://relay.example' });
  await savePendingFlow(db, {
    deviceCode: DEVICE,
    userCode: USER_CODE,
    interval: 5,
    expiresAt: 500,
  });
  const expiredPage = page(async () => {
    throw new Error('should not poll an expired flow');
  });
  const expired = mountGithub(expiredPage.doc, db, { now: () => 1_000, sleep: () => Promise.resolve() });
  expired.resume();
  await until(async () => expiredPage.nodes['github-status'].textContent === 'The code expired. Start again.'
    && (await loadPendingFlow(db)) === null);
  assert.equal(expiredPage.nodes['github-try-again'].hidden, false);
  assert.equal(expiredPage.nodes['github-device'].hidden, true);
  assert.equal(await loadPendingFlow(db), null);
  assert.equal(domText(expiredPage.nodes).includes(DEVICE), false);

  await savePendingFlow(db, {
    deviceCode: DEVICE,
    userCode: USER_CODE,
    interval: 5,
    expiresAt: 50_000,
  });
  const deniedPage = page(async (url) => {
    assert.equal(String(url).includes(DEVICE), false);
    return jsonResponse({ error: 'access_denied' });
  });
  const denied = mountGithub(deniedPage.doc, db, { now: () => 1_000, sleep: () => Promise.resolve() });
  denied.resume();
  await until(async () => deniedPage.nodes['github-status'].textContent === 'GitHub sign-in was declined.'
    && (await loadPendingFlow(db)) === null);
  assert.equal(deniedPage.nodes['github-try-again'].hidden, false);
  assert.equal(await loadPendingFlow(db), null);
  assert.equal(domText(deniedPage.nodes).includes(DEVICE), false);
  db.close();
  await deleteDatabase(name);
});

test('slow_down adds five seconds and the next wait keeps that pace', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const sleeps = [];
  const posts = [];
  const { doc, nodes } = page(async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : {};
    assert.equal(String(url).includes(DEVICE), false);
    if (String(url).endsWith('/device/code')) {
      return jsonResponse({
        user_code: USER_CODE,
        device_code: DEVICE,
        interval: 5,
        expires_in: 90,
        verification_uri_complete: `${DEVICE_PAGE}?user_code=${USER_CODE}`,
      });
    }
    posts.push(body.error || 'token');
    if (posts.length === 1) return jsonResponse({ error: 'slow_down' });
    if (posts.length === 2) return jsonResponse({ error: 'authorization_pending' });
    if (String(url) === 'https://api.github.com/user') return jsonResponse({ login: 'octocat' });
    return jsonResponse({ access_token: TOKEN });
  });
  mountGithub(doc, db, {
    now: () => 1_000,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  nodes['github-client-id'].value = 'Iv1.public';
  nodes['github-relay'].value = 'https://relay.example';
  nodes['github-connect'].click();
  await until(() => nodes['github-repo'].focused);
  assert.deepEqual(sleeps, [5000, 10000, 10000]);
  assert.equal(await loadPendingFlow(db), null);
  assert.equal(nodes['github-repo'].focused, true);
  assert.equal(domText(nodes).includes(DEVICE), false);
  db.close();
  await deleteDatabase(name);
});

test('copy and open uses the device page and keeps the device code out of the URL', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await saveGithubConfig(db, { clientId: 'Iv1.public', relay: 'https://relay.example' });
  await savePendingFlow(db, {
    deviceCode: DEVICE,
    userCode: USER_CODE,
    interval: 5,
    expiresAt: 50_000,
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { doc, nodes, view, opens, copies } = page(async () => {
    await gate;
    return jsonResponse({ error: 'authorization_pending' });
  });
  const order = [];
  view.open = (url) => {
    order.push('open');
    opens.push(url);
    return {};
  };
  view.navigator.clipboard.writeText = (text) => {
    order.push('copy');
    copies.push(text);
    return Promise.resolve();
  };
  const app = mountGithub(doc, db, { now: () => 1_000, sleep: () => Promise.resolve() });
  app.resume();
  await until(() => nodes['github-user-code'].textContent === USER_CODE);
  nodes['github-open-github'].click();
  assert.deepEqual(opens, [DEVICE_PAGE]);
  assert.equal(order[0], 'open');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(copies, [USER_CODE]);
  assert.deepEqual(order, ['open', 'copy']);
  assert.equal(nodes['github-verify'].href, DEVICE_PAGE);
  assert.equal(nodes['github-verify'].target, '_blank');
  assert.equal(nodes['github-status'].textContent.includes('come back to Core Sample'), true);
  view.copyResult = () => Promise.reject(new Error('blocked'));
  view.navigator.clipboard.writeText = () => {
    order.push('copy-fail');
    return Promise.reject(new Error(`blocked ${DEVICE}`));
  };
  nodes['github-open-github'].click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nodes['github-status'].textContent, 'Copy the code shown above. Approve it on GitHub, then come back to Core Sample.');
  assert.equal(nodes['github-status'].textContent.includes(DEVICE), false);
  assert.equal(domText(nodes).includes(DEVICE), false);
  nodes['github-cancel'].click();
  release();
  await until(() => nodes['github-status'].textContent === 'Sign-in was cancelled.');
  db.close();
  await deleteDatabase(name);
});

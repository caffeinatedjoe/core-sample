import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deleteDatabase, getMeta, openDatabase } from '../app/js/db.js';
import { createDeviceSignIn, tokenPollRequest } from '../app/js/github-device.js';
import { AUTH_RECHECK_MS, describeAccess, relayPost } from '../app/js/github-api.js';
import { createAutoSync, SYNC_STATUS } from '../app/js/github-sync.js';
import { mountGithub } from '../app/js/github-ui.js';
import {
  AUTH_FAILURE_KEY,
  authFailureRecord,
  authLogLeaksSecret,
  claimDevicePoll,
  clearPendingFlow,
  completeDeviceSignIn,
  describeAuthFailure,
  describeTokenMeta,
  formatAuthLog,
  loadAuthFailure,
  loadAuthLog,
  loadGithubSettings,
  loadPendingFlow,
  loadTokenMeta,
  recordAuthFailure,
  releaseDevicePoll,
  saveGithubConfig,
  saveGithubLogin,
  saveGithubSession,
  saveGithubTarget,
  savePendingFlow,
  tokenFingerprint,
} from '../app/js/github-store.js';
import { createFakeDevice } from './helpers/fake-device.js';
import { createFakeGit } from './helpers/fake-git.js';
import { domText, jsonResponse, page, until } from './helpers/github-page.js';

const RELAY = 'https://relay.example';
const CLIENT = 'Iv1.public';

async function freshDb() {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  return {
    db,
    async done() {
      db.close();
      await deleteDatabase(name);
    },
  };
}

async function approvedFlow(db, device) {
  await saveGithubConfig(db, { clientId: CLIENT, relay: RELAY });
  await savePendingFlow(db, {
    deviceCode: device.deviceCode,
    userCode: device.userCode,
    interval: 5,
    expiresAt: 900_000,
  });
  device.approve();
}

function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

test('a relaunch while the login lookup is out never polls the used device code again', async () => {
  const { db, done } = await freshDb();
  const device = createFakeDevice();
  try {
    await approvedFlow(db, device);
    const lookup = gate();
    device.state.holdUser = lookup.promise;

    // The first launch gets the token, then iOS suspends or reloads it while
    // GET /user is still out.
    const first = page(device.fetchImpl);
    const firstApp = mountGithub(first.doc, db, { now: () => 1_000, sleep: () => Promise.resolve() });
    firstApp.resume();
    await until(() => device.state.userCalls === 1);
    assert.equal(device.state.pollsAfterApproval, 1);

    // The next launch, the SW reload, or a visibility resume.
    device.state.holdUser = null;
    const second = page(device.fetchImpl);
    const secondApp = mountGithub(second.doc, db, {
      now: () => 2_000,
      sleep: () => Promise.resolve(),
      recheckSleep: () => Promise.resolve(),
    });
    await secondApp.refresh();
    await secondApp.resume();
    second.doc.dispatch('visibilitychange');
    second.view.dispatch('pageshow');
    second.nodes['github-check-now'].click();
    await settle();

    // The first launch's late lookup finishes after the second one is up.
    lookup.open();
    await until(() => first.nodes['github-status'].textContent.startsWith('Signed in'));
    await secondApp.whenChecked();

    assert.equal(device.state.pollsAfterApproval, 1, 'the used device code was polled again');
    assert.equal(await loadPendingFlow(db), null);
    const saved = await loadGithubSettings(db);
    assert.equal(saved.token, device.state.issued[0]);
    assert.equal(device.works(saved.token), true, 'the saved token was regenerated away');
    assert.equal(saved.login, 'octocat');
    assert.notEqual(second.nodes['github-login'].textContent, 'Sign in again');
    for (const nodes of [first.nodes, second.nodes]) {
      assert.equal(domText(nodes).includes(saved.token), false);
      assert.equal(domText(nodes).includes(device.deviceCode), false);
    }
  } finally {
    await done();
  }
});

function memoryStore(flow) {
  const box = { pending: flow ? { ...flow } : null, token: '' };
  return {
    box,
    loadPending: async () => (box.pending ? { ...box.pending } : null),
    savePending: async (next) => {
      box.pending = { ...next };
    },
    clearPending: async () => {
      box.pending = null;
    },
    completeFlow: async (token, used) => {
      box.token = token;
      if (box.pending && box.pending.deviceCode === used.deviceCode) box.pending = null;
    },
  };
}

test('the token is stored and the flow ended before any follow-up runs, so a second loop finds nothing to poll', async () => {
  const device = createFakeDevice();
  device.approve();
  const store = memoryStore({ deviceCode: device.deviceCode, userCode: device.userCode, interval: 5, expiresAt: 900_000 });
  const post = (deviceCode) => relayPost(device.fetchImpl, RELAY, 'token', tokenPollRequest(CLIENT, deviceCode), [CLIENT, deviceCode]);
  const hang = gate();
  const order = [];
  const first = createDeviceSignIn({
    ...store,
    postToken: post,
    sleep: () => Promise.resolve(),
    now: () => 1_000,
    onToken: async (token) => {
      order.push(['onToken', token === store.box.token, store.box.pending]);
      await hang.promise;
    },
  });
  const running = first.resume();
  await until(() => order.length === 1);
  assert.deepEqual(order[0], ['onToken', true, null]);

  first.checkNow();
  first.resume();
  const second = createDeviceSignIn({
    ...store,
    postToken: post,
    sleep: () => Promise.resolve(),
    now: () => 1_000,
    onToken: async () => {
      throw new Error('a second token');
    },
  });
  const idle = await second.resume();
  assert.equal(idle.idle, true);
  hang.open();
  await running;
  assert.equal(await first.resume().then((result) => result.idle), true);
  assert.equal(device.state.pollsAfterApproval, 1);
  assert.equal(device.works(store.box.token), true);
});

test('a code that already returned a token is cleared, not polled, if it is somehow still saved', async () => {
  const device = createFakeDevice();
  device.approve();
  const flow = { deviceCode: device.deviceCode, userCode: device.userCode, interval: 5, expiresAt: 900_000 };
  const store = memoryStore(flow);
  store.completeFlow = async (token) => {
    store.box.token = token;
  };
  const signIn = createDeviceSignIn({
    ...store,
    postToken: (deviceCode) => relayPost(device.fetchImpl, RELAY, 'token', tokenPollRequest(CLIENT, deviceCode), [CLIENT, deviceCode]),
    sleep: () => Promise.resolve(),
    now: () => 1_000,
  });
  await signIn.resume();
  store.box.pending = { ...flow };
  const again = await signIn.resume();
  assert.equal(again.idle, true);
  assert.equal(store.box.pending, null);
  assert.equal(device.state.pollsAfterApproval, 1);
});

test('the token write and the end of the pending flow are one write, and a late login never restores an older token', async () => {
  const { db, done } = await freshDb();
  try {
    await savePendingFlow(db, { deviceCode: 'fake-device-code-0001', userCode: 'WXYZ-0001', interval: 5, expiresAt: 900_000 });
    await completeDeviceSignIn(db, { token: 'fake-oauth-value-0001', deviceCode: 'fake-device-code-0001' });
    assert.equal(await loadPendingFlow(db), null);
    assert.equal((await loadGithubSettings(db)).token, 'fake-oauth-value-0001');

    await savePendingFlow(db, { deviceCode: 'fake-device-code-0002', userCode: 'WXYZ-0002', interval: 5, expiresAt: 900_000 });
    await completeDeviceSignIn(db, { token: 'fake-oauth-value-0002', deviceCode: 'fake-device-code-0001' });
    assert.equal((await loadPendingFlow(db)).deviceCode, 'fake-device-code-0002', 'a newer pending flow was dropped');
    await clearPendingFlow(db);

    assert.equal(await saveGithubLogin(db, { token: 'fake-oauth-value-0001', login: 'octocat' }), false);
    let saved = await loadGithubSettings(db);
    assert.equal(saved.token, 'fake-oauth-value-0002');
    assert.equal(saved.login, '');
    assert.equal(await saveGithubLogin(db, { token: 'fake-oauth-value-0002', login: 'octocat' }), true);
    saved = await loadGithubSettings(db);
    assert.equal(saved.token, 'fake-oauth-value-0002');
    assert.equal(saved.login, 'octocat');
  } finally {
    await done();
  }
});

function userSequence(statuses, token) {
  const seen = [];
  return {
    seen,
    fetchImpl: async (url, options = {}) => {
      assert.equal(String(url).includes(token), false);
      seen.push(options.headers.Authorization === `Bearer ${token}`);
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      if (status === 200) return jsonResponse({ login: 'octocat' });
      return jsonResponse({ message: `Bad credentials ${token}` }, status);
    },
  };
}

test('a 401 from GET /user is asked again with a short backoff before it means Sign in again', async () => {
  const token = 'fake-oauth-value-0001';
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
  };
  const flaky = userSequence([401, 200], token);
  const ok = await describeAccess(flaky.fetchImpl, { token }, { sleep });
  assert.equal(ok.state, 'signed-in');
  assert.equal(ok.login, 'octocat');
  assert.equal(ok.failure, undefined);
  assert.deepEqual(waits, [AUTH_RECHECK_MS[0]]);

  waits.length = 0;
  const gone = userSequence([401], token);
  const bad = await describeAccess(gone.fetchImpl, { token }, { sleep });
  assert.equal(bad.state, 'unauthorized');
  assert.deepEqual(waits, [...AUTH_RECHECK_MS]);
  assert.equal(gone.seen.length, 1 + AUTH_RECHECK_MS.length);
  assert.ok(gone.seen.every(Boolean), 'every try sends the Authorization header');
  assert.equal(bad.failure.endpoint, 'GET /user');
  assert.equal(bad.failure.status, 401);
  assert.equal(bad.failure.message.includes(token), false);
  assert.match(bad.failure.message, /^Bad credentials/);
});

async function syncHarness(statuses) {
  const { db, done } = await freshDb();
  const token = 'fake-oauth-value-0001';
  await saveGithubSession(db, { token, login: 'octocat' });
  await saveGithubTarget(db, { repo: 'owner/repo', branch: 'main', root: '' });
  const git = createFakeGit({ token, files: { 'A.md': 'alpha\n' } });
  const waits = [];
  const seen = [];
  const sync = createAutoSync({
    db,
    fetchImpl: async (url, options = {}) => {
      const path = new URL(String(url)).pathname;
      seen.push(path);
      if ((path === '/user' || path.endsWith('/git/ref/heads/main')) && statuses.length) {
        const status = statuses.shift();
        if (status === 401) return jsonResponse({ message: 'Bad credentials' }, 401);
      }
      return git.fetchImpl(url, options);
    },
    now: () => 1_700_000_000_000,
    random: () => 0,
    setTimer: () => ({ unref() {} }),
    clearTimer() {},
    async sleep(ms) {
      waits.push(ms);
    },
  });
  return { db, done, sync, waits, seen, token };
}

test('sync rechecks a 401 before it shows Authentication required, and records only the failure', async () => {
  const brief = await syncHarness([401, 401]);
  try {
    const result = await brief.sync.runNow();
    assert.equal(result.authRequired, false);
    assert.notEqual(result.status, SYNC_STATUS.auth);
    assert.deepEqual(brief.waits, [AUTH_RECHECK_MS[0]]);
    assert.equal(await getMeta(brief.db, AUTH_FAILURE_KEY), undefined);
  } finally {
    await brief.done();
  }

  const lasting = await syncHarness([401, 401, 401, 401]);
  try {
    const result = await lasting.sync.runNow();
    assert.equal(result.authRequired, true);
    assert.equal(result.status, SYNC_STATUS.auth);
    assert.deepEqual(lasting.waits, [...AUTH_RECHECK_MS]);
    const record = await getMeta(lasting.db, AUTH_FAILURE_KEY);
    assert.deepEqual(record, { at: 1_700_000_000_000, endpoint: 'GET /user', status: 401, message: 'Bad credentials', fingerprint: '0001' });
    assert.equal(JSON.stringify(record).includes(lasting.token), false);
    assert.equal((await loadGithubSettings(lasting.db)).token, lasting.token);
  } finally {
    await lasting.done();
  }
});

test('a declined device sign-in is recorded with GitHub\'s words and shown in the sheet, without the device code', async () => {
  const { db, done } = await freshDb();
  const deviceCode = 'fake-device-code-0009';
  try {
    await saveGithubConfig(db, { clientId: CLIENT, relay: RELAY });
    await savePendingFlow(db, { deviceCode, userCode: 'WXYZ-0009', interval: 5, expiresAt: 900_000 });
    const seen = page(async () => jsonResponse({
      error: 'access_denied',
      error_description: `The user has denied your application access for ${deviceCode}.`,
    }));
    const app = mountGithub(seen.doc, db, { now: () => 1_000, sleep: () => Promise.resolve() });
    await app.resume();
    const record = await loadAuthFailure(db);
    assert.equal(record.endpoint, 'POST /login/oauth/access_token');
    assert.equal(record.at, 1_000);
    assert.equal(record.message, 'access_denied: The user has denied your application access for [redacted].');
    assert.equal(JSON.stringify(await getMeta(db, AUTH_FAILURE_KEY)).includes(deviceCode), false);
    await app.refresh();
    assert.equal(seen.nodes['github-auth-failure'].hidden, false);
    assert.match(seen.nodes['github-auth-failure'].textContent, /POST \/login\/oauth\/access_token: access_denied/);
    assert.equal(domText(seen.nodes).includes(deviceCode), false);
  } finally {
    await done();
  }
});

test('the failure record keeps only time, endpoint, status, and a short redacted message', () => {
  const record = authFailureRecord({
    at: Date.UTC(2026, 10, 3, 17, 5),
    endpoint: 'https://api.github.com/user?access_token=x',
    status: 401,
    message: `Bad   credentials Bearer abc.def ${'x'.repeat(400)}`,
    token: 'fake-oauth-value-0001',
  }, ['fake-oauth-value-0001']);
  assert.deepEqual(Object.keys(record), ['at', 'endpoint', 'status', 'message', 'fingerprint']);
  assert.equal(record.endpoint, 'GitHub');
  assert.equal(record.fingerprint, '0001');
  assert.equal(record.message.includes('abc.def'), false);
  assert.ok(record.message.length <= 160);
  const line = describeAuthFailure({ ...record, endpoint: 'GET /user', message: 'Bad credentials' }, { locale: 'en-US', timeZone: 'UTC' });
  assert.equal(line, 'Last sign-in problem, Nov 3, 5:05 PM. GET /user HTTP 401: Bad credentials. sent …0001, saved …0001');
  assert.equal(describeAuthFailure(null), '');
});

test('an older in-flight poll cannot overwrite the last token GitHub returned', async () => {
  const { db, done } = await freshDb();
  try {
    const savedNew = await completeDeviceSignIn(db, {
      token: 'fake-oauth-value-0002',
      deviceCode: 'fake-device-code-0001',
      seq: 2,
      now: 2_000,
    });
    assert.equal(savedNew, true);
    const savedOld = await completeDeviceSignIn(db, {
      token: 'fake-oauth-value-0001',
      deviceCode: 'fake-device-code-0001',
      seq: 1,
      now: 1_000,
    });
    assert.equal(savedOld, false);
    const saved = await loadGithubSettings(db);
    assert.equal(saved.token, 'fake-oauth-value-0002');
    const meta = await loadTokenMeta(db);
    assert.equal(meta.fingerprint, '0002');
    assert.equal(meta.seq, 2);
    assert.equal(meta.source, 'device-flow');
  } finally {
    await done();
  }
});

test('two overlapping polls keep the last GitHub token, not the first', async () => {
  const { db, done } = await freshDb();
  const device = createFakeDevice();
  try {
    await approvedFlow(db, device);
    const gates = [gate(), gate()];
    let polls = 0;
    const post = async (deviceCode) => {
      const index = polls;
      polls += 1;
      await gates[index].promise;
      return relayPost(device.fetchImpl, RELAY, 'token', tokenPollRequest(CLIENT, deviceCode), [CLIENT, deviceCode]);
    };
    const hangFirst = gate();
    const first = createDeviceSignIn({
      loadPending: () => loadPendingFlow(db),
      savePending: (flow) => savePendingFlow(db, flow),
      clearPending: () => clearPendingFlow(db),
      claimPoll: (code) => claimDevicePoll(db, code, 1_000, { holdMs: 0 }),
      releasePoll: (code) => releaseDevicePoll(db, code),
      completeFlow: async (token, flow, seq) => {
        if (seq === 1) await hangFirst.promise;
        return completeDeviceSignIn(db, { token, deviceCode: flow.deviceCode, seq, now: 1_000 + seq });
      },
      postToken: post,
      sleep: () => Promise.resolve(),
      now: () => 1_000,
    });
    const second = createDeviceSignIn({
      loadPending: () => loadPendingFlow(db),
      savePending: (flow) => savePendingFlow(db, flow),
      clearPending: () => clearPendingFlow(db),
      claimPoll: (code) => claimDevicePoll(db, code, 2_000, { holdMs: 0 }),
      releasePoll: (code) => releaseDevicePoll(db, code),
      completeFlow: (token, flow, seq) => completeDeviceSignIn(db, {
        token,
        deviceCode: flow.deviceCode,
        seq,
        now: 2_000,
      }),
      postToken: post,
      sleep: () => Promise.resolve(),
      now: () => 2_000,
    });
    const runningFirst = first.resume();
    await until(() => polls === 1);
    const runningSecond = second.resume();
    await until(() => polls === 2);
    gates[0].open();
    gates[1].open();
    await runningSecond;
    hangFirst.open();
    await runningFirst;
    const saved = await loadGithubSettings(db);
    assert.equal(device.state.pollsAfterApproval, 2);
    assert.equal(saved.token, device.state.issued[1]);
    assert.equal(device.works(saved.token), true);
    assert.equal(device.works(device.state.issued[0]), false);
    assert.equal(await loadPendingFlow(db), null);
  } finally {
    await done();
  }
});

test('the sign-in log never contains more than the last 4 characters of a token', async () => {
  const { db, done } = await freshDb();
  const token = 'fake-oauth-value-0001';
  const deviceCode = 'fake-device-code-0001';
  const userCode = 'WXYZ-0001';
  try {
    await completeDeviceSignIn(db, { token, deviceCode, seq: 1, now: 1_000 });
    await recordAuthFailure(db, {
      at: 2_000,
      endpoint: 'GET /user',
      status: 401,
      message: `Bad credentials ${token} for ${deviceCode}`,
      token,
    }, [token, deviceCode]);
    const seen = page(async () => jsonResponse({ login: 'octocat' }));
    const app = mountGithub(seen.doc, db, {
      now: () => 3_000,
      sleep: () => Promise.resolve(),
      recheckSleep: () => Promise.resolve(),
    });
    await app.refresh();
    await app.whenChecked();
    assert.equal(seen.nodes['github-token-meta'].hidden, false);
    assert.match(seen.nodes['github-token-meta'].textContent, /Token …0001/);
    assert.match(seen.nodes['github-token-meta'].textContent, /from device flow/);
    seen.nodes['github-copy-auth-log'].click();
    await until(() => seen.copies.length > 0);
    const log = seen.copies[0];
    const secrets = [token, deviceCode, userCode];
    assert.equal(authLogLeaksSecret(log, secrets), false);
    assert.equal(log.includes(token.slice(-4)), true);
    assert.equal(log.includes(token.slice(-5)), false);
    assert.equal(formatAuthLog(await loadAuthLog(db)).includes(token), false);
    assert.equal(describeTokenMeta(await loadTokenMeta(db)).includes(token), false);
    assert.equal(tokenFingerprint(token), '0001');
    assert.equal(domText(seen.nodes).includes(token), false);
    assert.equal(domText(seen.nodes).includes(deviceCode), false);
    assert.match(seen.nodes['github-auth-failure'].textContent, /sent …0001, saved …0001/);
  } finally {
    await done();
  }
});

test('a 401 that names a different sent fingerprint than the saved token is shown that way', async () => {
  const { db, done } = await freshDb();
  try {
    await saveGithubSession(db, { token: 'fake-oauth-value-0002', login: 'octocat', now: 2_000 });
    const line = describeAuthFailure({
      at: Date.UTC(2026, 10, 3, 23, 14),
      endpoint: 'GET /user',
      status: 401,
      message: 'Bad credentials',
      fingerprint: '0001',
    }, { locale: 'en-US', timeZone: 'UTC', savedFingerprint: '0002' });
    assert.equal(line, 'Last sign-in problem, Nov 3, 11:14 PM. GET /user HTTP 401: Bad credentials. sent …0001, saved …0002');
    assert.equal(line.includes('fake-oauth-value'), false);
  } finally {
    await done();
  }
});


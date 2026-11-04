import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTH_RECHECK_MS, describeAccess, relayPost } from '../app/js/github-api.js';
import { createDeviceSignIn, tokenPollRequest } from '../app/js/github-device.js';
import { createAutoSync, SYNC_STATUS } from '../app/js/github-sync.js';
import { mountGithub } from '../app/js/github-ui.js';
import {
  AUTH_FAILURE_KEY,
  authLogLeaksSecret,
  claimDevicePoll,
  completeDeviceSignIn,
  formatAuthLog,
  loadAuthFailure,
  loadAuthLog,
  loadGithubSettings,
  loadPendingFlow,
  loadTokenMeta,
  recordAuthFailure,
  releaseDevicePoll,
  saveGithubConfig,
  savePendingFlow,
  tokenFingerprint,
} from '../app/js/github-store.js';
import { getMeta } from '../app/js/db.js';
import { FAKE_CLIENT_ID, FAKE_RELAY, FAKE_TOKEN, createFakeGithub } from './helpers/fake-github.js';
import { domText, jsonResponse, page, until } from './helpers/github-page.js';
import { vaultPassHarness, vaultPassName } from './helpers/vault-pass.js';

function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test(vaultPassName('device flow signs in through the fake relay and never puts secrets in URLs'), async () => {
  const box = await vaultPassHarness({ signedIn: false });
  try {
    await saveGithubConfig(box.db, { clientId: FAKE_CLIENT_ID, relay: FAKE_RELAY });
    const ui = page(box.github.fetchImpl);
    mountGithub(ui.doc, box.db, { now: () => 1_000, sleep: () => Promise.resolve() });
    ui.nodes['github-client-id'].value = FAKE_CLIENT_ID;
    ui.nodes['github-relay'].value = FAKE_RELAY;
    ui.nodes['github-connect'].click();
    const pending = await until(() => loadPendingFlow(box.db));
    assert.equal(pending.userCode, box.github.device.userCode);
    assert.equal(ui.nodes['github-user-code'].textContent, box.github.device.userCode);
    assert.equal(domText(ui.nodes).includes(box.github.device.deviceCode), false);
    box.github.approve();
    ui.nodes['github-check-now'].click();
    await until(() => ui.nodes['github-target'].hidden === false);
    const saved = await loadGithubSettings(box.db);
    assert.equal(box.github.works(saved.token), true);
    assert.match(saved.token, /^fake-oauth-value-/);
    assert.equal(saved.login, 'octocat');
    assert.equal(domText(ui.nodes).includes(saved.token), false);
    assert.equal(JSON.stringify(box.github.outbound).includes(saved.token), false);
    assert.equal(JSON.stringify(box.github.outbound).includes(box.github.device.deviceCode), false);
  } finally {
    await box.close();
  }
});

test(vaultPassName('two overlapping polls keep the newest token'), async () => {
  const box = await vaultPassHarness({ signedIn: false });
  const device = box.github.device;
  try {
    await saveGithubConfig(box.db, { clientId: FAKE_CLIENT_ID, relay: FAKE_RELAY });
    await savePendingFlow(box.db, {
      deviceCode: device.deviceCode,
      userCode: device.userCode,
      interval: 5,
      expiresAt: 900_000,
    });
    device.approve();
    const gates = [gate(), gate()];
    let polls = 0;
    const post = async (deviceCode) => {
      const index = polls;
      polls += 1;
      await gates[index].promise;
      return relayPost(
        box.github.fetchImpl,
        FAKE_RELAY,
        'token',
        tokenPollRequest(FAKE_CLIENT_ID, deviceCode),
        [FAKE_CLIENT_ID, deviceCode],
      );
    };
    const hangFirst = gate();
    const first = createDeviceSignIn({
      loadPending: () => loadPendingFlow(box.db),
      savePending: (flow) => savePendingFlow(box.db, flow),
      clearPending: async () => {},
      claimPoll: (code) => claimDevicePoll(box.db, code, 1_000, { holdMs: 0 }),
      releasePoll: (code) => releaseDevicePoll(box.db, code),
      completeFlow: async (token, flow, seq) => {
        if (seq === 1) await hangFirst.promise;
        return completeDeviceSignIn(box.db, { token, deviceCode: flow.deviceCode, seq, now: 1_000 + seq });
      },
      postToken: post,
      sleep: () => Promise.resolve(),
      now: () => 1_000,
    });
    const second = createDeviceSignIn({
      loadPending: () => loadPendingFlow(box.db),
      savePending: (flow) => savePendingFlow(box.db, flow),
      clearPending: async () => {},
      claimPoll: (code) => claimDevicePoll(box.db, code, 2_000, { holdMs: 0 }),
      releasePoll: (code) => releaseDevicePoll(box.db, code),
      completeFlow: (token, flow, seq) => completeDeviceSignIn(box.db, {
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
    const saved = await loadGithubSettings(box.db);
    assert.equal(device.state.pollsAfterApproval, 2);
    assert.equal(saved.token, device.state.issued[1]);
    assert.equal(device.works(saved.token), true);
    assert.equal(device.works(device.state.issued[0]), false);
  } finally {
    await box.close();
  }
});

test(vaultPassName('a 401 from GET /user is rechecked before Sign in again'), async () => {
  const token = FAKE_TOKEN;
  const github = await createFakeGithub({ token });
  let userCalls = 0;
  const flaky = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/user') {
      userCalls += 1;
      if (userCalls === 1) return jsonResponse({ message: 'Bad credentials' }, 401);
    }
    return github.fetchImpl(url, options);
  };
  const waits = [];
  const ok = await describeAccess(flaky, { token }, { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(ok.state, 'signed-in');
  assert.equal(ok.login, 'octocat');
  assert.deepEqual(waits, [AUTH_RECHECK_MS[0]]);

  const box = await vaultPassHarness();
  try {
    let remaining = 4;
    const stuck = async (url, options = {}) => {
      const path = new URL(String(url)).pathname;
      if ((path === '/user' || path.endsWith('/git/ref/heads/main')) && remaining > 0) {
        remaining -= 1;
        return jsonResponse({ message: 'Bad credentials' }, 401);
      }
      return box.github.fetchImpl(url, options);
    };
    const rechecks = [];
    const sync = createAutoSync({
      db: box.db,
      fetchImpl: stuck,
      now: () => 1_700_000_000_000,
      random: () => 0,
      setTimer: () => ({ unref() {} }),
      clearTimer() {},
      async sleep(ms) {
        rechecks.push(ms);
      },
    });
    const result = await sync.runNow();
    assert.equal(result.status, SYNC_STATUS.auth);
    assert.deepEqual(rechecks, [...AUTH_RECHECK_MS]);
    const record = await getMeta(box.db, AUTH_FAILURE_KEY);
    assert.equal(record.endpoint, 'GET /user');
    assert.equal(record.fingerprint, tokenFingerprint(token));
    assert.equal(JSON.stringify(record).includes(token), false);
    assert.equal((await loadGithubSettings(box.db)).token, token);
    sync.stop();
  } finally {
    await box.close();
  }
});

test(vaultPassName('the sign-in log never holds more than the last 4 characters of a token'), async () => {
  const box = await vaultPassHarness({ signedIn: false });
  const token = FAKE_TOKEN;
  const deviceCode = box.github.device.deviceCode;
  try {
    await completeDeviceSignIn(box.db, { token, deviceCode, seq: 1, now: 1_000 });
    await recordAuthFailure(box.db, {
      at: 2_000,
      endpoint: 'GET /user',
      status: 401,
      message: `Bad credentials ${token} for ${deviceCode}`,
      token,
    }, [token, deviceCode]);
    const ui = page(async () => jsonResponse({ login: 'octocat' }));
    const app = mountGithub(ui.doc, box.db, {
      now: () => 3_000,
      sleep: () => Promise.resolve(),
      recheckSleep: () => Promise.resolve(),
    });
    await app.refresh();
    await app.whenChecked();
    ui.nodes['github-copy-auth-log'].click();
    await until(() => ui.copies.length > 0);
    const log = ui.copies[0];
    assert.equal(authLogLeaksSecret(log, [token, deviceCode, box.github.device.userCode]), false);
    assert.equal(log.includes(token.slice(-4)), true);
    assert.equal(log.includes(token.slice(-5)), false);
    assert.equal(formatAuthLog(await loadAuthLog(box.db)).includes(token), false);
    assert.equal(tokenFingerprint(token), '0001');
    assert.equal(domText(ui.nodes).includes(token), false);
    assert.equal((await loadAuthFailure(box.db)).fingerprint, '0001');
    assert.match(ui.nodes['github-auth-failure'].textContent, /sent …0001, saved …0001/);
    assert.equal((await loadTokenMeta(box.db)).fingerprint, '0001');
  } finally {
    await box.close();
  }
});

test(vaultPassName('a lasting 401 keeps the token and prompts to sign in again'), async () => {
  const box = await vaultPassHarness();
  try {
    const gone = async (url, options = {}) => {
      if (new URL(String(url)).pathname === '/user') return jsonResponse({ message: 'Bad credentials' }, 401);
      return box.github.fetchImpl(url, options);
    };
    const ui = page(gone);
    const app = mountGithub(ui.doc, box.db, {
      now: () => 1_000,
      sleep: () => Promise.resolve(),
      recheckSleep: () => Promise.resolve(),
    });
    await app.refresh();
    await app.whenChecked();
    assert.equal(ui.nodes['github-sign-in-again'].hidden, false);
    assert.match(ui.nodes['github-login'].textContent, /Sign in again/);
    assert.equal((await loadGithubSettings(box.db)).token, FAKE_TOKEN);
    assert.equal(ui.nodes['github-connect'].hidden, true);
    assert.equal(domText(ui.nodes).includes(FAKE_TOKEN), false);
  } finally {
    await box.close();
  }
});

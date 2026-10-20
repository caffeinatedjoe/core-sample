import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GITHUB_SCOPE,
  deviceCodeRequest,
  interpretPoll,
  readDeviceStart,
  runDevicePoll,
  signInWithDevice,
  tokenPollRequest,
  verificationLink,
} from '../app/js/github-device.js';
import { relayPost } from '../app/js/github-api.js';

const TOKEN = 'gho_testtokenvalue123456';

test('device flow asks for the private-repo scope and only the device endpoints', () => {
  assert.equal(GITHUB_SCOPE, 'repo');
  const body = deviceCodeRequest('Iv1.public');
  assert.deepEqual(body, { client_id: 'Iv1.public', scope: 'repo' });
  assert.equal(body.client_secret, undefined);
  assert.equal(tokenPollRequest('Iv1.public', 'device-secret').grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(verificationLink('https://github.com/login/device'), 'https://github.com/login/device');
  assert.equal(verificationLink('https://evil.example/login/device'), 'https://github.com/login/device');
  assert.equal(verificationLink('javascript:alert(1)'), 'https://github.com/login/device');
});

test('polling waits out the interval, slows down by five seconds, and then keeps that pace', async () => {
  let clock = 0;
  const sleeps = [];
  const posts = [
    { error: 'authorization_pending' },
    { error: 'slow_down' },
    { error: 'authorization_pending' },
    { access_token: TOKEN },
  ];
  const result = await runDevicePoll({
    interval: 5,
    expiresIn: 120,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    post: async () => posts.shift(),
  });
  assert.deepEqual(sleeps, [5000, 5000, 10000, 10000]);
  assert.equal(result.token, TOKEN);
  assert.equal(posts.length, 0);
});

test('a denied or expired sign-in stops with a fixed message and no token', async () => {
  const denied = interpretPoll({ error: 'access_denied', access_token: '' }, 5);
  assert.equal(denied.failure, 'GitHub sign-in was declined.');
  assert.equal(denied.token, undefined);
  assert.equal(interpretPoll({ error: 'expired_token' }, 5).failure, 'The code expired. Start again.');
  assert.equal(interpretPoll({ error: 'slow_down' }, 8).wait, 13);

  let clock = 0;
  const expired = await runDevicePoll({
    interval: 5,
    expiresIn: 8,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    post: async () => ({ error: 'authorization_pending' }),
  });
  assert.equal(expired.failure, 'The code expired. Start again.');
  assert.equal(expired.token, undefined);

  const leaked = await runDevicePoll({
    interval: 1,
    expiresIn: 30,
    now: () => 0,
    sleep: async () => {},
    post: async () => {
      throw new Error(`failed ${TOKEN}`);
    },
  });
  assert.equal(leaked.failure, 'The sign-in request failed.');
  assert.equal(leaked.failure.includes(TOKEN), false);
});

test('sign-in shows the user code, polls the relay, and does not reveal the device code', async () => {
  const seen = [];
  let clock = 0;
  let shown = null;
  const result = await signInWithDevice({
    clientId: 'Iv1.public',
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    onCode: (code) => {
      shown = code;
    },
    postJson: async (which, payload) => {
      seen.push({ which, payload });
      if (which === 'code') {
        return {
          user_code: 'ABCD-1234',
          device_code: 'device-secret-value',
          verification_uri: 'https://github.com/login/device',
          interval: 5,
          expires_in: 90,
        };
      }
      if (seen.length === 2) return { error: 'authorization_pending' };
      if (seen.length === 3) return { error: 'slow_down' };
      return { access_token: TOKEN };
    },
  });
  assert.deepEqual(shown, {
    userCode: 'ABCD-1234',
    verification: 'https://github.com/login/device',
  });
  assert.equal(Object.hasOwn(shown, 'deviceCode'), false);
  assert.equal(result.token, TOKEN);
  assert.equal(seen[0].payload.scope, 'repo');
  assert.equal(seen[1].payload.device_code, 'device-secret-value');
  assert.deepEqual(seen.map((call) => call.which), ['code', 'token', 'token', 'token']);
  assert.equal(JSON.stringify(result).includes('device-secret-value'), false);
});

test('the relay client posts only to the two device paths and drops token text from errors', async () => {
  const calls = [];
  await relayPost(async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ user_code: 'ABCD-1234', device_code: 'device-secret-value' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }, 'https://relay.example/device/code', 'code', deviceCodeRequest('Iv1.public'));
  assert.equal(calls[0].url, 'https://relay.example/device/code');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(JSON.parse(calls[0].options.body).client_secret, undefined);

  await assert.rejects(
    () => relayPost(async () => new Response(`nope ${TOKEN}`, { status: 500 }), 'https://relay.example', 'token', {}, [TOKEN]),
    (error) => {
      assert.equal(error.message.includes(TOKEN), false);
      assert.match(error.message, /\[redacted\]|GitHub returned 500/);
      return true;
    },
  );
});

test('a device start without codes fails closed', () => {
  assert.throws(() => readDeviceStart({ user_code: 'ABCD-1234' }), /did not return a device code/);
  const start = readDeviceStart({
    user_code: 'ABCD-1234',
    device_code: 'device-secret-value',
    verification_uri: 'https://github.com.evil/login/device',
  });
  assert.equal(start.verification, 'https://github.com/login/device');
  assert.equal(start.interval, 5);
});

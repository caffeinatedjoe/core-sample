import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALLOWED_ORIGIN, handleRelay } from '../worker/allow.js';

function request(path, {
  method = 'POST',
  origin = ALLOWED_ORIGIN,
  body = '{"client_id":"Iv1.public"}',
  headers = {},
} = {}) {
  const init = {
    method,
    headers: {
      origin,
      'content-type': 'application/json',
      ...headers,
    },
  };
  if (method !== 'GET' && method !== 'OPTIONS') init.body = body;
  return new Request(`https://relay.example${path}`, init);
}

test('the relay forwards only the two GitHub device endpoints for the app origin', async () => {
  const calls = [];
  const response = await handleRelay(request('/device/code'), async (url, options) => {
    calls.push({ url, options });
    return new Response('{"user_code":"ABCD-1234"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"user_code":"ABCD-1234"}');
  assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://github.com/login/device/code');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[0].options.headers.Authorization, undefined);

  const tokenCalls = [];
  await handleRelay(request('/oauth/access_token', { body: '{"device_code":"device-secret-value"}' }), async (url, options) => {
    tokenCalls.push({ url, options });
    return new Response('{"access_token":"gho_testtokenvalue123456"}', { status: 200 });
  });
  assert.equal(tokenCalls[0].url, 'https://github.com/login/oauth/access_token');
  assert.equal(tokenCalls[0].options.body, '{"device_code":"device-secret-value"}');
});

test('every other origin, method, and path is rejected and a redirect is not followed', async () => {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args);
  const fetchImpl = async () => {
    throw new Error('fetch should not run');
  };
  try {
    for (const origin of ['https://evil.example', 'https://joecoffey.me.evil.example', 'https://www.joecoffey.me', 'http://joecoffey.me', null]) {
      const headers = { 'content-type': 'application/json' };
      if (origin) headers.origin = origin;
      const response = await handleRelay(new Request('https://relay.example/device/code', {
        method: 'POST',
        headers,
        body: '{}',
      }), fetchImpl);
      assert.equal(response.status, 403, origin || 'missing origin');
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }

    const get = await handleRelay(request('/device/code', { method: 'GET' }), fetchImpl);
    assert.equal(get.status, 404);
    const other = await handleRelay(request('/repos/owner/repo'), fetchImpl);
    assert.equal(other.status, 404);
    const proxy = await handleRelay(request('/device/code?url=https://evil.example'), async (url) => {
      assert.equal(url, 'https://github.com/login/device/code');
      return new Response('{}', { status: 200 });
    });
    assert.equal(proxy.status, 200);

    const large = await handleRelay(request('/device/code', { body: 'x'.repeat(8193) }), fetchImpl);
    assert.equal(large.status, 413);
    const typed = await handleRelay(request('/device/code', { headers: { 'content-type': 'text/plain' } }), fetchImpl);
    assert.equal(typed.status, 415);

    const redirect = await handleRelay(request('/oauth/access_token'), async () => new Response('secret-body', {
      status: 302,
      headers: { location: 'https://evil.example/steal' },
    }));
    assert.equal(redirect.status, 502);
    assert.equal(await redirect.text(), 'Rejected.');

    const preflight = await handleRelay(request('/device/code', { method: 'OPTIONS' }), fetchImpl);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.equal(logs.length, 0);
  } finally {
    console.log = original;
  }
});

// Local stand-in for GitHub: the fixture vault as a repo, plus device flow
// behind a relay. Nothing here calls github.com. Writes stay in memory.
import { createServer } from 'node:http';
import { createFakeDevice } from './fake-device.js';
import { createFakeGit } from './fake-git.js';
import { FIXTURE_BRANCH, FIXTURE_REPO, loadFixtureVault } from './fixture-vault.js';

export const FAKE_CLIENT_ID = 'Iv1.public';
export const FAKE_RELAY = 'https://relay.example';
export const FAKE_TOKEN = 'fake-oauth-value-0001';
export const FAKE_LOGIN = 'octocat';

export const GITHUB_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, if-none-match, accept, x-github-api-version',
  'access-control-expose-headers': 'etag, retry-after, x-ratelimit-remaining, x-ratelimit-reset',
};

function jsonReply(status, body, headers = {}) {
  return {
    status,
    body: status === 304 ? null : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  };
}

function bearer(headers = {}) {
  const auth = headers.Authorization || headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
}

function withCors(result, extra = {}) {
  return {
    ...result,
    headers: { ...GITHUB_CORS, ...(result.headers || {}), ...extra },
  };
}

export async function createFakeGithub({
  files,
  repo = FIXTURE_REPO,
  branch = FIXTURE_BRANCH,
  token = FAKE_TOKEN,
  relay = FAKE_RELAY,
  device,
  signedIn = true,
} = {}) {
  const vault = files || await loadFixtureVault();
  const fakeDevice = device || createFakeDevice();
  if (signedIn && token) {
    fakeDevice.state.valid.add(token);
    if (!fakeDevice.state.issued.includes(token)) fakeDevice.state.issued.push(token);
  }
  // Auth is enforced here so a device-flow token can replace the preset.
  const git = createFakeGit({ token: '', repo, branch, files: vault });
  const outbound = [];

  function secrets() {
    return [fakeDevice.deviceCode, token, ...fakeDevice.state.issued].filter(Boolean);
  }

  function tokenOk(value) {
    return fakeDevice.state.valid.has(value);
  }

  async function handle({ method = 'GET', url, headers = {}, body = null } = {}) {
    const text = String(url);
    for (const secret of secrets()) {
      if (secret && text.includes(secret)) throw new Error('a secret leaked into the url');
    }
    outbound.push({ method, url: text });
    const parsed = new URL(text, 'https://api.github.com');
    const path = decodeURIComponent(parsed.pathname);

    if (method === 'OPTIONS') {
      const requested = headers['access-control-request-headers'] || headers['Access-Control-Request-Headers'];
      return withCors({
        status: 204,
        body: '',
        headers: requested ? { 'access-control-allow-headers': requested } : {},
      });
    }

    if (path.endsWith('/device/code') || path.endsWith('/oauth/access_token')) {
      const response = await fakeDevice.fetchImpl(text, { method, headers, body });
      const raw = await response.text();
      return withCors({
        status: response.status,
        body: raw,
        headers: { 'content-type': 'application/json' },
      });
    }

    const host = parsed.hostname;
    if (host === 'github.com' || host.endsWith('.github.com') && host !== 'api.github.com') {
      return withCors(jsonReply(404, { message: 'Not Found' }));
    }

    const sent = bearer(headers);
    if (!tokenOk(sent)) return withCors(jsonReply(401, { message: 'Bad credentials' }));

    const result = await git.handle({ method, url: text, headers, body });
    return withCors(result);
  }

  async function fetchImpl(url, options = {}) {
    const result = await handle({
      method: options.method || 'GET',
      url,
      headers: options.headers || {},
      body: options.body || null,
    });
    return new Response(result.body, { status: result.status, headers: result.headers });
  }

  function listen() {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8') || null;
      const result = await handle({
        method: req.method,
        url: `https://api.github.com${req.url}`,
        headers: req.headers,
        body,
      });
      const headers = { ...result.headers };
      res.writeHead(result.status, headers);
      res.end(result.body ?? '');
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  async function installRoutes(context) {
    const relayHost = new URL(relay).origin;
    const fulfill = async (route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') {
        const requested = request.headers()['access-control-request-headers'];
        await route.fulfill({
          status: 204,
          headers: {
            ...GITHUB_CORS,
            'access-control-allow-headers': requested || GITHUB_CORS['access-control-allow-headers'],
          },
        });
        return;
      }
      const { 'if-none-match': _etag, ...headers } = await request.allHeaders();
      const result = await handle({
        method: request.method(),
        url: request.url(),
        headers,
        body: request.postData(),
      });
      await route.fulfill({
        status: result.status === 304 ? 200 : result.status,
        headers: { ...GITHUB_CORS, ...(result.headers || {}) },
        body: result.body ?? '',
      });
    };
    await context.route('https://github.com/**', (route) => route.abort());
    await context.route('https://api.github.com/**', fulfill);
    await context.route(`${relayHost}/**`, fulfill);
  }

  return {
    git,
    device: fakeDevice,
    repo,
    branch,
    relay,
    token,
    outbound,
    handle,
    fetchImpl,
    listen,
    installRoutes,
    approve() {
      fakeDevice.approve();
    },
    works(value) {
      return fakeDevice.works(value);
    },
  };
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectDownload, encodeUtf8Base64 } from '../app/js/github-api.js';
import {
  FAKE_CLIENT_ID,
  FAKE_RELAY,
  FAKE_TOKEN,
  createFakeGithub,
} from './helpers/fake-github.js';
import { FIXTURE_REPO, loadFixtureVault } from './helpers/fixture-vault.js';

test('the fake GitHub serves the fixture as a read-only-from-the-world repo', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('the fake GitHub must not use the network');
  };
  try {
    const github = await createFakeGithub();
    const user = await github.fetchImpl('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
    });
    assert.equal(user.status, 200);
    assert.equal((await user.json()).login, 'octocat');

    const listed = await github.fetchImpl(`https://api.github.com/repos/${FIXTURE_REPO}`, {
      headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
    });
    assert.equal((await listed.json()).default_branch, 'main');

    const tree = await github.fetchImpl(`https://api.github.com/repos/${FIXTURE_REPO}/git/trees/main?recursive=1`, {
      headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
    });
    const body = await tree.json();
    assert.equal(body.truncated, false);
    const blobs = body.tree.filter((item) => item.type === 'blob').map((item) => item.path);
    assert.equal(blobs.includes('Site Log.md'), true);
    assert.equal(blobs.includes('.obsidian/app.json'), true);
    assert.equal(blobs.includes('assets/Site Log/image-20261029123530322.png'), true);

    const loaded = await collectDownload(github.fetchImpl, {
      repo: FIXTURE_REPO,
      branch: 'main',
      root: '',
      token: FAKE_TOKEN,
    });
    const site = loaded.find((note) => note.localPath === 'Site Log.md');
    assert.match(site.content, /!\[\[image-20261029123530322\.png\]\]/);
    assert.equal(loaded.attachments.some((item) => item.localPath.endsWith('.pdf')), true);

    const pngPath = 'assets/Site Log/image-20261029123530322.png';
    const raw = await github.fetchImpl(
      `https://api.github.com/repos/${FIXTURE_REPO}/contents/${encodeURI(pngPath)}?ref=main`,
      {
        headers: {
          Authorization: `Bearer ${FAKE_TOKEN}`,
          Accept: 'application/vnd.github.raw',
        },
      },
    );
    const bytes = Buffer.from(await raw.arrayBuffer());
    assert.equal(bytes[0], 0x89);
    assert.deepEqual(bytes, (await loadFixtureVault())[pngPath]);

    const denied = await github.fetchImpl('https://api.github.com/user', {
      headers: { Authorization: 'Bearer not-the-token' },
    });
    assert.equal(denied.status, 401);

    await assert.rejects(
      () => github.fetchImpl(`https://api.github.com/user?access_token=${FAKE_TOKEN}`),
      /secret leaked/,
    );
    assert.equal(github.outbound.some((item) => item.url.includes('github.com') && item.url.includes(FAKE_TOKEN)), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('writes land only in the in-memory repo, and a missing blob 404s without other files vanishing', async () => {
  const github = await createFakeGithub();
  const before = github.git.textAt('Daily.md');
  const put = await github.fetchImpl(`https://api.github.com/repos/${FIXTURE_REPO}/contents/Daily.md`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
    body: JSON.stringify({
      message: 'Update Daily.md from Core Sample',
      content: encodeUtf8Base64('# Daily\n\nedited in the fake\n'),
      branch: 'main',
      sha: github.git.blobShaAt('Daily.md'),
    }),
  });
  assert.equal(put.status, 200);
  assert.equal(github.git.textAt('Daily.md'), '# Daily\n\nedited in the fake\n');
  assert.notEqual(github.git.textAt('Daily.md'), before);
  assert.match(github.git.textAt('Inbox.md'), /#todo/);

  const pngSha = github.git.blobShaAt('assets/Site Log/image-20261029123530322.png');
  github.git.hideBlob(pngSha);
  const hidden = await github.fetchImpl(
    `https://api.github.com/repos/${FIXTURE_REPO}/git/blobs/${pngSha}`,
    { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } },
  );
  assert.equal(hidden.status, 404);
  const tree = await github.fetchImpl(`https://api.github.com/repos/${FIXTURE_REPO}/git/trees/main?recursive=1`, {
    headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
  });
  const stillListed = (await tree.json()).tree.some((item) => item.path === 'assets/Site Log/image-20261029123530322.png');
  assert.equal(stillListed, true);
  assert.match(github.git.textAt('Inbox.md'), /Label the trays/);
});

test('the local HTTP server and device-flow relay never talk to github.com', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('the fake GitHub must not use the network');
  };
  try {
    const github = await createFakeGithub({ signedIn: false, token: FAKE_TOKEN });
    const server = await github.listen();
    try {
      const { port } = server.address();
      const origin = `http://127.0.0.1:${port}`;
      const code = await github.fetchImpl(`${FAKE_RELAY}/device/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: FAKE_CLIENT_ID, scope: 'repo' }),
      });
      const started = await code.json();
      assert.equal(started.user_code, github.device.userCode);
      assert.equal(JSON.stringify(started).includes(github.device.deviceCode) === true, true);
      github.approve();
      const token = await github.fetchImpl(`${FAKE_RELAY}/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: FAKE_CLIENT_ID,
          device_code: github.device.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const granted = await token.json();
      assert.match(granted.access_token, /^fake-oauth-value-/);
      assert.equal(github.works(granted.access_token), true);

      const localUser = await originalFetch(`${origin}/user`, {
        headers: { Authorization: `Bearer ${granted.access_token}` },
      });
      assert.equal(localUser.status, 200);
      assert.equal((await localUser.json()).login, 'octocat');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planFileRename } from '../app/js/organize.js';
import {
  applyPull,
  applyPushResult,
  cleanRelayUrl,
  collectDownload,
  contentsUrl,
  encodeUtf8Base64,
  planDownload,
  pullFile,
  pushFile,
  pushRequest,
  readErrorMessage,
  selectMarkdown,
} from '../app/js/github-api.js';

const TOKEN = 'gho_testtokenvalue123456';

function note(path, content, extra = {}) {
  return {
    path,
    content,
    kind: 'markdown',
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 2,
    trashedAt: null,
    remoteSha: null,
    dirty: false,
    ...extra,
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('a push sends the stored blob SHA and a mismatch keeps the local note', async () => {
  const local = note('Field notes.md', 'local 日本語', { remoteSha: 'abc111', dirty: true });
  const body = pushRequest(local, 'main');
  assert.equal(body.sha, 'abc111');
  assert.equal(body.branch, 'main');
  assert.equal(body.content, encodeUtf8Base64('local 日本語'));
  assert.equal(body.force, undefined);
  assert.equal(pushRequest(note('New.md', 'x'), 'main').sha, undefined);

  const calls = [];
  const refused = await pushFile(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(409, { message: `mismatch ${TOKEN}` });
  }, { file: local, repo: 'owner/repo', branch: 'main', root: '', token: TOKEN });
  assert.equal(refused.changed, false);
  assert.equal(refused.file, local);
  assert.equal(refused.file.content, 'local 日本語');
  assert.equal(refused.file.remoteSha, 'abc111');
  assert.equal(refused.message.includes(TOKEN), false);
  assert.match(refused.message, /kept/);
  assert.equal(calls[0].url, contentsUrl('owner/repo', 'Field notes.md', 'main'));
  assert.equal(calls[0].url.includes(TOKEN), false);
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(JSON.parse(calls[0].options.body).sha, 'abc111');

  const created = await pushFile(async () => jsonResponse(422, { message: 'path exists' }), {
    file: note('New.md', 'mine'),
    repo: 'owner/repo',
    branch: 'main',
    root: 'notes',
    token: TOKEN,
  });
  assert.equal(created.changed, false);
  assert.equal(created.file.content, 'mine');
  assert.match(created.message, /kept/);

  const pushed = await pushFile(async (url) => {
    assert.equal(url, 'https://api.github.com/repos/owner/repo/contents/notes/Field%20notes.md?ref=main');
    return jsonResponse(200, { content: { sha: 'def222' } });
  }, { file: local, repo: 'owner/repo', branch: 'main', root: 'notes', token: TOKEN });
  assert.equal(pushed.changed, true);
  assert.equal(pushed.file.content, 'local 日本語');
  assert.equal(pushed.file.remoteSha, 'def222');
  assert.equal(pushed.file.dirty, false);
  assert.equal(applyPushResult(local, { ok: true, sha: '' }).changed, false);
});

test('pull refuses to replace a dirty note and still updates a clean one', async () => {
  const dirty = note('Field notes.md', 'local words', { remoteSha: 'abc111', dirty: true });
  const kept = applyPull(dirty, { path: 'Field notes.md', content: 'remote words', sha: 'def222' });
  assert.equal(kept.action, 'keep');
  assert.equal(kept.file, dirty);
  assert.equal(kept.file.content, 'local words');

  const calls = [];
  const pulled = await pullFile(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, {
      sha: 'def222',
      encoding: 'base64',
      content: encodeUtf8Base64('remote words'),
    });
  }, { file: dirty, repo: 'owner/repo', branch: 'main', root: '', token: TOKEN });
  assert.equal(pulled.action, 'keep');
  assert.equal(pulled.file.content, 'local words');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].url.includes(TOKEN), false);
  assert.match(pulled.message, /not replaced/);

  const unsynced = await pullFile(async () => jsonResponse(200, {
    sha: 'def222',
    encoding: 'base64',
    content: encodeUtf8Base64('remote words'),
  }), { file: note('Field notes.md', 'local words'), repo: 'owner/repo', branch: 'main', root: '', token: TOKEN });
  assert.equal(unsynced.action, 'keep');
  assert.equal(unsynced.file.content, 'local words');

  const clean = note('Field notes.md', 'old', { remoteSha: 'abc111', dirty: false });
  const updated = await pullFile(async () => jsonResponse(200, {
    sha: 'def222',
    encoding: 'base64',
    content: encodeUtf8Base64('remote words'),
  }), { file: clean, repo: 'owner/repo', branch: 'main', root: '', token: TOKEN });
  assert.equal(updated.action, 'update');
  assert.equal(updated.file.content, 'remote words');
  assert.equal(updated.file.remoteSha, 'def222');
  assert.equal(updated.file.dirty, false);

  const same = applyPull(dirty, { path: 'Field notes.md', content: 'local words', sha: 'eee333' });
  assert.equal(same.action, 'adopt');
  assert.equal(same.file.remoteSha, 'eee333');
  assert.equal(same.file.dirty, false);
  assert.equal(same.file.content, 'local words');
});

test('download keeps existing notes beside new ones unless replace is explicit', () => {
  const remote = [
    { localPath: 'Welcome.md', content: 'from git', sha: 'aaa' },
    { localPath: 'New.md', content: 'new', sha: 'bbb' },
  ];
  const local = [note('Welcome.md', 'on phone'), note('Trash.md', 'gone', { trashedAt: 4 })];
  const beside = planDownload(local, remote, 'alongside');
  assert.deepEqual(beside.writes.map((item) => item.localPath), ['New.md']);
  assert.deepEqual(beside.skipped, ['Welcome.md']);
  assert.deepEqual(beside.remove, []);
  const replaced = planDownload(local, remote, 'replace');
  assert.deepEqual(replaced.writes.map((item) => item.localPath), ['Welcome.md', 'New.md']);
  assert.deepEqual(replaced.remove, ['Welcome.md', 'Trash.md']);
  assert.throws(() => planDownload(local, remote, 'merge'), /Choose how/);
});

test('markdown download respects the notes root and stops when the listing is cut off', async () => {
  const selected = selectMarkdown({
    truncated: false,
    tree: [
      { path: 'README.md', type: 'blob', sha: '1' },
      { path: 'notes/A.md', type: 'blob', sha: '2' },
      { path: 'notes/pic.png', type: 'blob', sha: '3' },
      { path: 'notes/sub/B.md', type: 'blob', sha: '4' },
      { path: 'other/C.md', type: 'blob', sha: '5' },
    ],
  }, 'notes');
  assert.deepEqual(selected.map((item) => item.localPath), ['A.md', 'sub/B.md']);
  assert.throws(() => selectMarkdown({ truncated: true, tree: [] }, ''), /cut off/);

  let fetches = 0;
  await assert.rejects(() => collectDownload(async (url) => {
    fetches += 1;
    if (url.includes('/git/trees/')) {
      return jsonResponse(200, {
        tree: [
          { path: 'A.md', type: 'blob', sha: '2' },
          { path: 'B.md', type: 'blob', sha: '4' },
        ],
      });
    }
    if (url.endsWith('/A.md?ref=main')) {
      return jsonResponse(200, { sha: '2', encoding: 'base64', content: encodeUtf8Base64('A') });
    }
    return jsonResponse(500, { message: `boom ${TOKEN}` });
  }, { repo: 'owner/repo', branch: 'main', root: '', token: TOKEN }), (error) => {
    assert.equal(error.message.includes(TOKEN), false);
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
  assert.equal(fetches, 3);

  const loaded = await collectDownload(async () => jsonResponse(200, {
    sha: '2',
    encoding: 'base64',
    content: encodeUtf8Base64('hello'),
    tree: [{ path: 'A.md', type: 'blob', sha: '2' }],
  }), { repo: 'owner/repo', branch: 'main', root: '', token: TOKEN });
  assert.equal(loaded[0].content, 'hello');
  assert.equal(loaded[0].sha, '2');
  assert.equal(cleanRelayUrl('https://relay.example/device/code'), 'https://relay.example');
});

test('a rename clears the blob SHA and an error never repeats a token', () => {
  const files = [
    note('Welcome.md', 'See [[Field notes]]\n', { remoteSha: 'keep' }),
    note('Field notes.md', '# Stay\n', { remoteSha: 'drop', dirty: false }),
  ];
  const result = planFileRename(files, 'Field notes.md', 'Cores.md', 20);
  const moved = result.files.find((item) => item.path === 'Cores.md');
  const welcome = result.files.find((item) => item.path === 'Welcome.md');
  assert.equal(moved.remoteSha, null);
  assert.equal(moved.dirty, true);
  assert.equal(moved.content, '# Stay\n');
  assert.equal(welcome.remoteSha, 'keep');
  assert.equal(welcome.dirty, true);
  assert.equal(readErrorMessage(409, `{"message":"bad ${TOKEN}"}`, [TOKEN]).includes(TOKEN), false);
  assert.match(readErrorMessage(409, 'not json at all', [TOKEN]), /GitHub returned 409/);
});

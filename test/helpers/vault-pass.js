// Shared IndexedDB + fake GitHub harness for the scripted vault-pass checks.
import { randomUUID } from 'node:crypto';
import { commitFiles, deleteDatabase, getFile, listFiles, openDatabase, putFile } from '../../app/js/db.js';
import {
  collectDownload,
  fileFromRemote,
  fileFromRemoteAttachment,
  planDownload,
} from '../../app/js/github-api.js';
import { createAutoSync } from '../../app/js/github-sync.js';
import { saveGithubSession, saveGithubTarget } from '../../app/js/github-store.js';
import { FAKE_LOGIN, FAKE_TOKEN, createFakeGithub } from './fake-github.js';
import { FIXTURE_REPO } from './fixture-vault.js';

export function vaultPassName(title) {
  return `vault-pass: ${title}`;
}

export async function vaultPassHarness({ signedIn = true, token = FAKE_TOKEN, github: githubOptions } = {}) {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const github = await createFakeGithub({ signedIn, token, ...githubOptions });
  if (signedIn) {
    await saveGithubSession(db, { token, login: FAKE_LOGIN });
    await saveGithubTarget(db, { repo: github.repo, branch: github.branch, root: '' });
  }
  const history = [];
  const sleeps = [];
  const scheduled = [];
  let time = 1_700_000_000_000;
  const sync = createAutoSync({
    db,
    fetchImpl: github.fetchImpl,
    now: () => time,
    random: () => 0,
    setTimer(fn, ms) {
      const id = { fn, ms, unref() {} };
      scheduled.push(id);
      return id;
    },
    clearTimer() {},
    async sleep(ms) {
      sleeps.push(ms);
    },
    onStatus(text) {
      history.push(text);
    },
  });
  return {
    db,
    github,
    git: github.git,
    sync,
    history,
    sleeps,
    scheduled,
    token,
    repo: github.repo || FIXTURE_REPO,
    tick(ms) {
      time += ms;
    },
    async download() {
      const loaded = await collectDownload(github.fetchImpl, {
        repo: github.repo,
        branch: github.branch,
        root: '',
        token,
      });
      const local = await listFiles(db);
      const plan = planDownload(local, loaded, 'alongside');
      const now = Date.now();
      const notes = plan.writes.map((note) => fileFromRemote(
        { localPath: note.localPath },
        note.content,
        note.sha,
        now,
      ));
      const taken = new Set([...local.map((file) => file.path), ...notes.map((file) => file.path)]);
      const stubs = [];
      for (const entry of loaded.attachments || []) {
        if (!entry || taken.has(entry.localPath)) continue;
        stubs.push(fileFromRemoteAttachment(entry, now));
        taken.add(entry.localPath);
      }
      const writes = [...notes, ...stubs];
      if (writes.length) await commitFiles(db, { put: writes, remove: plan.remove });
      return { loaded, writes, skipped: plan.skipped };
    },
    async edit(path, content) {
      const file = await getFile(db, path);
      const next = {
        ...(file || {
          path,
          kind: 'markdown',
          encoding: 'utf-8',
          createdAt: time,
          trashedAt: null,
          origin: 'user',
        }),
        content,
        dirty: true,
        updatedAt: time,
        origin: file?.origin === 'app' ? 'user' : (file?.origin || 'user'),
      };
      await putFile(db, next);
      await sync.noteEdited(next);
      return next;
    },
    async close() {
      sync.stop();
      db.close();
      await deleteDatabase(name);
    },
  };
}

import { commitFiles, getMeta, listFiles, setMeta } from './db.js';

export const TOKEN_KEY = 'githubToken';
export const CLIENT_ID_KEY = 'githubClientId';
export const RELAY_KEY = 'githubRelay';
export const REPO_KEY = 'githubRepo';
export const BRANCH_KEY = 'githubBranch';
export const ROOT_KEY = 'githubRoot';
export const LOGIN_KEY = 'githubLogin';
export const PENDING_KEY = 'githubPending';

async function clear(db, key) {
  await setMeta(db, key, null);
}

export async function loadGithubSettings(db) {
  const [clientId, relay, token, repo, branch, root, login] = await Promise.all([
    getMeta(db, CLIENT_ID_KEY),
    getMeta(db, RELAY_KEY),
    getMeta(db, TOKEN_KEY),
    getMeta(db, REPO_KEY),
    getMeta(db, BRANCH_KEY),
    getMeta(db, ROOT_KEY),
    getMeta(db, LOGIN_KEY),
  ]);
  return {
    clientId: typeof clientId === 'string' ? clientId : '',
    relay: typeof relay === 'string' ? relay : '',
    token: typeof token === 'string' && token ? token : '',
    repo: typeof repo === 'string' ? repo : '',
    branch: typeof branch === 'string' ? branch : '',
    root: typeof root === 'string' ? root : '',
    login: typeof login === 'string' ? login : '',
  };
}

export async function saveGithubConfig(db, { clientId = '', relay = '' }) {
  await setMeta(db, CLIENT_ID_KEY, clientId);
  await setMeta(db, RELAY_KEY, relay);
}

export async function saveGithubSession(db, { token, login = '' }) {
  await setMeta(db, TOKEN_KEY, token);
  await setMeta(db, LOGIN_KEY, login);
}

export async function saveGithubTarget(db, { repo, branch, root }) {
  await setMeta(db, REPO_KEY, repo);
  await setMeta(db, BRANCH_KEY, branch);
  await setMeta(db, ROOT_KEY, root);
}

export async function loadPendingFlow(db) {
  const value = await getMeta(db, PENDING_KEY);
  if (!value || typeof value !== 'object') return null;
  if (typeof value.deviceCode !== 'string' || !value.deviceCode) return null;
  if (typeof value.userCode !== 'string' || !value.userCode) return null;
  const expiresAt = Number(value.expiresAt);
  if (!(expiresAt > 0)) return null;
  return {
    deviceCode: value.deviceCode,
    userCode: value.userCode,
    interval: Number(value.interval) > 0 ? Number(value.interval) : 5,
    expiresAt,
  };
}

export async function savePendingFlow(db, flow) {
  await setMeta(db, PENDING_KEY, {
    deviceCode: flow.deviceCode,
    userCode: flow.userCode,
    interval: Number(flow.interval) > 0 ? Number(flow.interval) : 5,
    expiresAt: Number(flow.expiresAt),
  });
}

export async function clearPendingFlow(db) {
  await clear(db, PENDING_KEY);
}

export async function disconnectGithub(db) {
  await clear(db, TOKEN_KEY);
  await clear(db, REPO_KEY);
  await clear(db, BRANCH_KEY);
  await clear(db, ROOT_KEY);
  await clear(db, LOGIN_KEY);
  await clearPendingFlow(db);
}

export async function eraseLocalNotes(db) {
  const files = await listFiles(db);
  await commitFiles(db, { remove: files.map((file) => file.path) });
  await setMeta(db, 'folders', []);
  await setMeta(db, 'recent', []);
  await setMeta(db, 'expanded', []);
  await setMeta(db, 'lastOpened', null);
  await setMeta(db, 'seeded', true);
}

import { commitFiles, deleteOps, getMeta, listFiles, listOps, setMeta, updateMeta } from './db.js';
import { redact } from './github-redact.js';

export const TOKEN_KEY = 'githubToken';
export const CLIENT_ID_KEY = 'githubClientId';
export const RELAY_KEY = 'githubRelay';
export const REPO_KEY = 'githubRepo';
export const BRANCH_KEY = 'githubBranch';
export const ROOT_KEY = 'githubRoot';
export const LOGIN_KEY = 'githubLogin';
export const PENDING_KEY = 'githubPending';
export const STORAGE_KEY = 'storagePersistent';
export const AUTH_FAILURE_KEY = 'githubAuthFailure';

export function storagePersistenceText(granted) {
  return granted === true
    ? 'Storage on this phone is set to stay.'
    : 'Storage on this phone is not set to stay.';
}

export async function rememberStoragePersistence(storage) {
  if (!storage || typeof storage.persist !== 'function') return false;
  try {
    if (typeof storage.persisted === 'function' && await storage.persisted()) return true;
    return (await storage.persist()) === true;
  } catch {
    return false;
  }
}

export async function recordStoragePersistence(db, storage) {
  const granted = await rememberStoragePersistence(storage);
  try {
    await setMeta(db, STORAGE_KEY, granted);
  } catch {
    // The notes still open when this flag cannot be stored.
  }
  return granted;
}

export async function loadStorageFlag(db) {
  return (await getMeta(db, STORAGE_KEY)) === true;
}

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
  await updateMeta(db, [], () => ({ [TOKEN_KEY]: token, [LOGIN_KEY]: login }));
}

// A device code is single use. The token it returned and the end of the
// pending flow are written together, before any network call, so a reload
// or a second launch can never find the code again and poll it a second time.
// The pending flow is cleared only when it is still this code.
export async function completeDeviceSignIn(db, { token, deviceCode }) {
  await updateMeta(db, [PENDING_KEY], (values) => {
    const writes = { [TOKEN_KEY]: token, [LOGIN_KEY]: '' };
    const pending = values[PENDING_KEY];
    if (!pending || pending.deviceCode === deviceCode) writes[PENDING_KEY] = null;
    return writes;
  });
}

// Fills in the login for a token that is still the saved one. It never
// writes the token, so a slow lookup cannot put an older token back.
export async function saveGithubLogin(db, { token, login }) {
  const writes = await updateMeta(db, [TOKEN_KEY, LOGIN_KEY], (values) => {
    if (!token || values[TOKEN_KEY] !== token) return null;
    if (values[LOGIN_KEY] === login) return null;
    return { [LOGIN_KEY]: login };
  });
  return Boolean(writes);
}

const AUTH_ENDPOINTS = new Set(['GET /user', 'POST /login/oauth/access_token']);
const AUTH_MESSAGE_MAX = 160;

// What the GitHub sheet shows about the last sign-in failure. It holds the
// time, the endpoint, the HTTP status and GitHub's own words, never a token
// or a device code.
export function authFailureRecord({ at, endpoint, status, message }, secrets = []) {
  const clean = redact(String(message || ''), secrets).replace(/\s+/g, ' ').trim();
  return {
    at: Number(at) > 0 ? Number(at) : 0,
    endpoint: AUTH_ENDPOINTS.has(endpoint) ? endpoint : 'GitHub',
    status: Number.isInteger(status) && status > 0 ? status : 0,
    message: clean.length > AUTH_MESSAGE_MAX ? `${clean.slice(0, AUTH_MESSAGE_MAX - 1)}…` : clean,
  };
}

export async function recordAuthFailure(db, failure, secrets = []) {
  const record = authFailureRecord(failure, secrets);
  await setMeta(db, AUTH_FAILURE_KEY, record);
  return record;
}

export async function loadAuthFailure(db) {
  const value = await getMeta(db, AUTH_FAILURE_KEY);
  if (!value || typeof value !== 'object' || !(Number(value.at) > 0)) return null;
  return authFailureRecord(value);
}

export function describeAuthFailure(record, { locale, timeZone } = {}) {
  if (!record || !(record.at > 0)) return '';
  let when = '';
  try {
    when = new Date(record.at).toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    });
  } catch {
    when = new Date(record.at).toISOString();
  }
  const status = record.status ? ` HTTP ${record.status}` : '';
  const said = record.message ? `: ${record.message}` : '';
  return `Last sign-in problem, ${when}. ${record.endpoint}${status}${said}`;
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
  const ops = await listOps(db);
  if (ops.length) await deleteOps(db, ops.map((op) => op.id));
  await setMeta(db, 'folders', []);
  await setMeta(db, 'recent', []);
  await setMeta(db, 'expanded', []);
  await setMeta(db, 'lastOpened', null);
  await setMeta(db, 'seeded', true);
}

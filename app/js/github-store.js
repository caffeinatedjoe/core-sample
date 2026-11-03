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
export const TOKEN_META_KEY = 'githubTokenMeta';
export const POLL_SEQ_KEY = 'githubPollSeq';
export const AUTH_LOG_KEY = 'githubAuthLog';
export const AUTH_LOG_LIMIT = 20;
export const POLL_CLAIM_MS = 20_000;

const TOKEN_SOURCES = new Set(['device-flow', 'existing', 'session', 'migration']);
const AUTH_EVENT_TYPES = new Set(['token-saved', 'token-read', 'unauthorized', 'recheck', 'sign-out']);
const AUTH_ENDPOINTS = new Set(['GET /user', 'POST /login/oauth/access_token']);
const AUTH_MESSAGE_MAX = 160;
const SOURCE_LABEL = {
  'device-flow': 'from device flow',
  existing: 'already on this phone',
  session: 'from a saved session',
  migration: 'from a migration',
};

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

export async function saveGithubSession(db, { token, login = '', now = Date.now(), source = 'session' }) {
  await updateMeta(db, [POLL_SEQ_KEY, AUTH_LOG_KEY], (values) => {
    const seq = (Number(values[POLL_SEQ_KEY]) || 0) + 1;
    const meta = tokenMetaRecord({ token, at: now, source, seq });
    return {
      [TOKEN_KEY]: token,
      [LOGIN_KEY]: login,
      [POLL_SEQ_KEY]: seq,
      [TOKEN_META_KEY]: meta,
      [AUTH_LOG_KEY]: nextLog(values, {
        at: now,
        type: 'token-saved',
        fingerprint: meta.fingerprint,
        path: source,
      }, [token]),
    };
  });
}

// Last 4 characters only, and only when the value is long enough that those
// 4 are not the whole secret. GitHub's security log shows the last 8.
export function tokenFingerprint(token) {
  const value = typeof token === 'string' ? token : '';
  if (value.length < 8) return '';
  return value.slice(-4);
}

export function formatFingerprint(tokenOrFp) {
  const fp = asFingerprint(tokenOrFp);
  return fp ? `…${fp}` : '';
}

function asFingerprint(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9]{4}$/.test(text)) return text;
  return tokenFingerprint(text);
}

export function tokenMetaRecord({ token, at, source, seq } = {}) {
  return {
    fingerprint: tokenFingerprint(token),
    at: Number(at) > 0 ? Number(at) : 0,
    source: TOKEN_SOURCES.has(source) ? source : 'device-flow',
    seq: Number(seq) > 0 ? Number(seq) : 0,
  };
}

export async function loadTokenMeta(db) {
  const value = await getMeta(db, TOKEN_META_KEY);
  if (!value || typeof value !== 'object') return null;
  const fingerprint = asFingerprint(value.fingerprint);
  if (!fingerprint) return null;
  return {
    fingerprint,
    at: Number(value.at) > 0 ? Number(value.at) : 0,
    source: TOKEN_SOURCES.has(value.source) ? value.source : 'device-flow',
    seq: Number(value.seq) > 0 ? Number(value.seq) : 0,
  };
}

function formatClock(at, { locale, timeZone } = {}) {
  if (!(Number(at) > 0)) return '';
  try {
    return new Date(at).toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    });
  } catch {
    return new Date(at).toISOString();
  }
}

export function describeTokenMeta(meta, { locale, timeZone } = {}) {
  if (!meta || !meta.fingerprint) return '';
  const when = formatClock(meta.at, { locale, timeZone });
  const how = SOURCE_LABEL[meta.source] || '';
  const saved = when ? `saved ${when}` : 'saved on this phone';
  return how ? `Token …${meta.fingerprint}, ${saved}, ${how}.` : `Token …${meta.fingerprint}, ${saved}.`;
}

export function authEventRecord({ at, type, fingerprint, path, detail } = {}, secrets = []) {
  return {
    at: Number(at) > 0 ? Number(at) : 0,
    type: AUTH_EVENT_TYPES.has(type) ? type : 'token-read',
    fingerprint: asFingerprint(fingerprint),
    path: redact(String(path || ''), secrets).replace(/\s+/g, ' ').trim().slice(0, 80),
    detail: redact(String(detail || ''), secrets).replace(/\s+/g, ' ').trim().slice(0, 80),
  };
}

function nextLog(values, event, secrets = []) {
  const prev = Array.isArray(values[AUTH_LOG_KEY]) ? values[AUTH_LOG_KEY] : [];
  const clean = prev.map((item) => authEventRecord(item, secrets)).filter((item) => item.at > 0);
  return [...clean, authEventRecord(event, secrets)].slice(-AUTH_LOG_LIMIT);
}

export async function appendAuthEvent(db, event, secrets = []) {
  const writes = await updateMeta(db, [AUTH_LOG_KEY], (values) => ({
    [AUTH_LOG_KEY]: nextLog(values, event, secrets),
  }));
  const log = writes && writes[AUTH_LOG_KEY];
  return log && log.length ? log[log.length - 1] : authEventRecord(event, secrets);
}

export async function loadAuthLog(db) {
  const value = await getMeta(db, AUTH_LOG_KEY);
  if (!Array.isArray(value)) return [];
  return value.map((item) => authEventRecord(item)).filter((item) => item.at > 0).slice(-AUTH_LOG_LIMIT);
}

export function formatAuthLog(events) {
  const lines = ['Core Sample sign-in log'];
  for (const event of events || []) {
    const record = authEventRecord(event);
    if (!record.at) continue;
    const when = new Date(record.at).toISOString();
    const fp = record.fingerprint ? ` …${record.fingerprint}` : '';
    const path = record.path ? ` ${record.path}` : '';
    const detail = record.detail ? ` ${record.detail}` : '';
    lines.push(`${when} ${record.type}${fp}${path}${detail}`.trimEnd());
  }
  return lines.join('\n');
}

// True when `text` holds a secret, or more than the last 4 characters of one.
export function authLogLeaksSecret(text, secrets = []) {
  const haystack = String(text || '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 5) continue;
    if (haystack.includes(secret)) return true;
    if (haystack.includes(secret.slice(-5))) return true;
  }
  return false;
}

export async function noteTokenRead(db, { path = 'startup', now = Date.now() } = {}) {
  const token = await getMeta(db, TOKEN_KEY);
  const fingerprint = tokenFingerprint(typeof token === 'string' ? token : '');
  if (!fingerprint) return '';
  const meta = await loadTokenMeta(db);
  if (!meta) {
    await updateMeta(db, [AUTH_LOG_KEY], (values) => ({
      [TOKEN_META_KEY]: tokenMetaRecord({ token, at: now, source: 'existing', seq: 0 }),
      [AUTH_LOG_KEY]: nextLog(values, { at: now, type: 'token-read', fingerprint, path }, [token]),
    }));
    return fingerprint;
  }
  await appendAuthEvent(db, { at: now, type: 'token-read', fingerprint, path }, [token]);
  return fingerprint;
}

// A device code is single use. The token it returned and the end of the
// pending flow are written together, before any network call, so a reload
// or a second launch can never find the code again and poll it a second time.
// The pending flow is cleared only when it is still this code.
// Each poll is numbered when it is sent. A later complete from an earlier
// poll cannot put that first, now-dead, token back.
export async function completeDeviceSignIn(db, { token, deviceCode, seq, now = Date.now() }) {
  const incoming = Number(seq) > 0 ? Number(seq) : 0;
  const secrets = [token, deviceCode];
  const writes = await updateMeta(db, [PENDING_KEY, TOKEN_META_KEY, POLL_SEQ_KEY, AUTH_LOG_KEY], (values) => {
    const current = values[TOKEN_META_KEY];
    const currentSeq = current && Number(current.seq) > 0 ? Number(current.seq) : 0;
    if (incoming > 0 && currentSeq > 0 && incoming <= currentSeq) {
      return {
        [AUTH_LOG_KEY]: nextLog(values, {
          at: now,
          type: 'token-saved',
          fingerprint: tokenFingerprint(token),
          path: 'device-flow-ignored',
          detail: 'older poll',
        }, secrets),
      };
    }
    const nextSeq = incoming > 0 ? incoming : currentSeq + 1;
    const meta = tokenMetaRecord({ token, at: now, source: 'device-flow', seq: nextSeq });
    const out = {
      [TOKEN_KEY]: token,
      [LOGIN_KEY]: '',
      [TOKEN_META_KEY]: meta,
      [POLL_SEQ_KEY]: Math.max(Number(values[POLL_SEQ_KEY]) || 0, nextSeq),
      [AUTH_LOG_KEY]: nextLog(values, {
        at: now,
        type: 'token-saved',
        fingerprint: meta.fingerprint,
        path: 'device-flow',
      }, secrets),
    };
    const pending = values[PENDING_KEY];
    if (!pending || pending.deviceCode === deviceCode) out[PENDING_KEY] = null;
    return out;
  });
  return Boolean(writes && writes[TOKEN_KEY]);
}

// One in-flight token poll per device code. A second page, a service worker
// reload, or Check now cannot start another request until this one returns,
// or the claim is older than POLL_CLAIM_MS.
export async function claimDevicePoll(db, deviceCode, now = Date.now(), { holdMs = POLL_CLAIM_MS } = {}) {
  const box = { status: 'idle' };
  const writes = await updateMeta(db, [PENDING_KEY, POLL_SEQ_KEY], (values) => {
    const pending = values[PENDING_KEY];
    if (!pending || pending.deviceCode !== deviceCode) {
      box.status = 'idle';
      return null;
    }
    const claimedAt = Number(pending.pollClaimedAt) || 0;
    const hold = Number(holdMs) >= 0 ? Number(holdMs) : POLL_CLAIM_MS;
    if (claimedAt && now - claimedAt < hold) {
      box.status = 'busy';
      return null;
    }
    box.status = 'claimed';
    const seq = (Number(values[POLL_SEQ_KEY]) || 0) + 1;
    return {
      [POLL_SEQ_KEY]: seq,
      [PENDING_KEY]: { ...pending, pollClaimedAt: now },
    };
  });
  if (box.status === 'claimed' && writes) return { ok: true, seq: writes[POLL_SEQ_KEY] };
  return { ok: false, idle: box.status === 'idle', busy: box.status === 'busy' };
}

export async function releaseDevicePoll(db, deviceCode) {
  await updateMeta(db, [PENDING_KEY], (values) => {
    const pending = values[PENDING_KEY];
    if (!pending || pending.deviceCode !== deviceCode) return null;
    if (!pending.pollClaimedAt) return null;
    return { [PENDING_KEY]: { ...pending, pollClaimedAt: 0 } };
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

// What the GitHub sheet shows about the last sign-in failure. It holds the
// time, the endpoint, the HTTP status, GitHub's own words, and the last 4
// of the token that was sent, never a token or a device code.
export function authFailureRecord({ at, endpoint, status, message, fingerprint, token } = {}, secrets = []) {
  const extra = [token, fingerprint].filter((item) => typeof item === 'string' && item.length >= 8);
  const clean = redact(String(message || ''), [...secrets, ...extra]).replace(/\s+/g, ' ').trim();
  return {
    at: Number(at) > 0 ? Number(at) : 0,
    endpoint: AUTH_ENDPOINTS.has(endpoint) ? endpoint : 'GitHub',
    status: Number.isInteger(status) && status > 0 ? status : 0,
    message: clean.length > AUTH_MESSAGE_MAX ? `${clean.slice(0, AUTH_MESSAGE_MAX - 1)}…` : clean,
    fingerprint: asFingerprint(fingerprint) || tokenFingerprint(token),
  };
}

export async function recordAuthFailure(db, failure, secrets = []) {
  const record = authFailureRecord(failure, secrets);
  await updateMeta(db, [AUTH_LOG_KEY], (values) => ({
    [AUTH_FAILURE_KEY]: record,
    [AUTH_LOG_KEY]: nextLog(values, {
      at: record.at,
      type: 'unauthorized',
      fingerprint: record.fingerprint,
      path: record.endpoint,
      detail: `${record.status ? `HTTP ${record.status}` : ''} ${record.message}`.trim(),
    }, secrets),
  }));
  return record;
}

export async function loadAuthFailure(db) {
  const value = await getMeta(db, AUTH_FAILURE_KEY);
  if (!value || typeof value !== 'object' || !(Number(value.at) > 0)) return null;
  return authFailureRecord(value);
}

export function describeAuthFailure(record, { locale, timeZone, savedFingerprint } = {}) {
  if (!record || !(record.at > 0)) return '';
  const when = formatClock(record.at, { locale, timeZone }) || new Date(record.at).toISOString();
  const status = record.status ? ` HTTP ${record.status}` : '';
  const said = record.message ? `: ${record.message}` : '';
  const sent = record.fingerprint ? `…${record.fingerprint}` : '';
  const saved = asFingerprint(savedFingerprint);
  const savedText = saved ? `…${saved}` : sent;
  let extra = '';
  if (sent || saved) extra = `. sent ${sent || 'none'}, saved ${savedText || 'none'}`;
  return `Last sign-in problem, ${when}. ${record.endpoint}${status}${said}${extra}`;
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
  await updateMeta(db, [PENDING_KEY], (values) => {
    const prev = values[PENDING_KEY] && typeof values[PENDING_KEY] === 'object' ? values[PENDING_KEY] : {};
    const same = prev.deviceCode === flow.deviceCode;
    return {
      [PENDING_KEY]: {
        deviceCode: flow.deviceCode,
        userCode: flow.userCode,
        interval: Number(flow.interval) > 0 ? Number(flow.interval) : 5,
        expiresAt: Number(flow.expiresAt),
        pollClaimedAt: same ? Number(prev.pollClaimedAt) || 0 : 0,
      },
    };
  });
}

export async function clearPendingFlow(db) {
  await clear(db, PENDING_KEY);
}

export async function disconnectGithub(db, { now = Date.now() } = {}) {
  const token = await getMeta(db, TOKEN_KEY);
  const fingerprint = tokenFingerprint(typeof token === 'string' ? token : '');
  await updateMeta(db, [AUTH_LOG_KEY], (values) => ({
    [TOKEN_KEY]: null,
    [REPO_KEY]: null,
    [BRANCH_KEY]: null,
    [ROOT_KEY]: null,
    [LOGIN_KEY]: null,
    [PENDING_KEY]: null,
    [TOKEN_META_KEY]: null,
    [AUTH_LOG_KEY]: nextLog(values, {
      at: now,
      type: 'sign-out',
      fingerprint,
      path: 'disconnect',
    }, [token]),
  }));
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

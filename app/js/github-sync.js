// Automatic sync. The local-save clock is separate and must already have
// written the note before a debounced run pushes it.
import { commitFiles, deleteOps, getFile, getMeta, listFiles, listOps, putFile, putOp, setMeta } from './db.js';
import {
  decodeUtf8Base64,
  githubRequest,
  AUTH_RECHECK_MS,
  githubStatusReason,
  readUser,
  repoPath,
  selectMarkdown,
} from './github-api.js';
import { loadGithubSettings, recordAuthFailure } from './github-store.js';
import { redact } from './github-redact.js';
import { GITHUB_DELETED_TEXT, hasConflictRemote, merge2, merge3 } from './conflicts.js';
import { isIgnoredPath } from './vault-paths.js';

export const SYNC_DEBOUNCE_MS = 3000;
export const SYNC_POLL_MS = 60 * 1000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;
const CURSOR_KEY = 'githubSyncCursor';

export const SYNC_STATUS = {
  synced: 'Synced',
  syncing: 'Syncing',
  offline: 'Offline',
  pending: 'Changes pending',
  conflict: 'Conflict',
  auth: 'Authentication required',
  failed: 'Sync failed',
};

const DELETED_COPY = GITHUB_DELETED_TEXT;
// A rejected ref update means another client (Obsidian Git on a computer)
// pushed first. Each retry rebuilds on the new head after a short wait.
export const RACE_RETRY_LIMIT = 4;
const RACE_BASE_MS = 400;
const RACE_CAP_MS = 4000;
export const REMOTE_LOAD_TIMEOUT_MS = 15000;

export function raceDelay(attempt, random = Math.random) {
  const n = Math.max(0, Number(attempt) || 0);
  const exp = Math.min(RACE_CAP_MS, RACE_BASE_MS * (2 ** n));
  const roll = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.round(exp * (0.5 + roll * 0.5));
}

function openConflict(file) {
  return Boolean(file && file.conflict === true && !file.conflictCopy && !file.trashedAt && !isIgnoredPath(file.path));
}

export function presentSyncStatus(state = {}) {
  if (!state.configured) return '';
  let text = '';
  if (state.authRequired) text = SYNC_STATUS.auth;
  else if (state.conflict) text = SYNC_STATUS.conflict;
  else if (state.offline) text = SYNC_STATUS.offline;
  else if (state.failed) text = SYNC_STATUS.failed;
  else if (state.syncing) text = SYNC_STATUS.syncing;
  else if (state.pending || state.retrying) text = SYNC_STATUS.pending;
  else if (state.confirmed) text = SYNC_STATUS.synced;
  else text = SYNC_STATUS.syncing;
  const copies = Number(state.copies) || 0;
  if (copies > 0 && text && text !== SYNC_STATUS.conflict) {
    text += ` · ${copies} conflict ${copies === 1 ? 'copy' : 'copies'}`;
  }
  return text;
}

export function backoffDelay(attempt, random = Math.random) {
  const n = Math.max(0, Number(attempt) || 0);
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * (2 ** n));
  const roll = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.round(exp * (0.5 + roll * 0.5));
}

function header(headers, name) {
  if (!headers) return '';
  const value = headers[name] ?? headers[name.toLowerCase()];
  return value == null ? '' : String(value);
}

// 403 counts only when the rate-limit quota is spent. 429 always counts.
export function retryDelay({ status = 0, headers = {}, attempt = 0, now = Date.now(), random = () => 0 } = {}) {
  const remaining = header(headers, 'x-ratelimit-remaining');
  const reset = header(headers, 'x-ratelimit-reset');
  const retryAfter = header(headers, 'retry-after');
  const limited = status === 429 || (status === 403 && remaining === '0');
  if (limited) {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
      const when = Date.parse(retryAfter);
      if (!Number.isNaN(when)) return Math.max(0, when - now);
    }
    const resetMs = Number(reset) * 1000;
    if (reset && Number.isFinite(resetMs)) return Math.max(0, resetMs - now);
  }
  if (limited || status === 0 || status >= 500) return backoffDelay(attempt, random);
  return 0;
}

export function utcConflictStamp(when) {
  const date = when instanceof Date ? when : new Date(when);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function conflictCopyPath(path, when, taken = new Set()) {
  const stamp = utcConflictStamp(when);
  const slash = String(path).lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = slash >= 0 ? path.slice(slash + 1) : String(path);
  const stem = base.replace(/\.md$/i, '');
  const first = `${dir}${stem} (conflict ${stamp}).md`;
  if (!taken.has(first)) return first;
  let n = 2;
  let name = `${dir}${stem} (conflict ${stamp}-${n}).md`;
  while (taken.has(name)) {
    n += 1;
    name = `${dir}${stem} (conflict ${stamp}-${n}).md`;
  }
  return name;
}

export function commitMessage(paths, deletions = []) {
  const notes = paths || [];
  const removed = deletions || [];
  if (!notes.length && removed.length === 1) return `Delete ${removed[0]} from Core Sample`;
  if (!notes.length && removed.length) return `Delete ${removed.length} notes from Core Sample`;
  if (notes.length === 1 && removed.length === 1) return `Rename ${removed[0]} to ${notes[0]} from Core Sample`;
  if (notes.length === 1 && !removed.length) return `Update ${notes[0]} from Core Sample`;
  return `Update ${notes.length + removed.length} notes from Core Sample`;
}

export function refUpdateBody(sha) {
  return { sha, force: false };
}

// GitHub's read is singular. The update is plural and rejects a moved head when force is false.
export function refReadPath(branch) {
  return `/git/ref/heads/${encodeURIComponent(branch)}`;
}

export function refUpdatePath(branch) {
  return `/git/refs/heads/${encodeURIComponent(branch)}`;
}

function preparedKey(parent, files, deletions = []) {
  return JSON.stringify([
    parent,
    (files || []).map((file) => [file.path, String(file.content ?? '')]),
    (deletions || []).map((item) => item.path),
  ]);
}

export function syncedBase(file) {
  if (!file) return '';
  if (typeof file.baseSha === 'string' && file.baseSha) return file.baseSha;
  if (typeof file.remoteSha === 'string' && file.remoteSha) return file.remoteSha;
  return '';
}

export function isLocalCopyName(path) {
  return / \((?:conflict|backup) \d{4}-\d{2}-\d{2} \d{4}(?:-\d+)?\)\.md$/i.test(String(path || ''));
}

export function isAppGenerated(file) {
  if (!file) return false;
  if (file.localOnly === true || file.origin === 'app') return true;
  if (file.origin === 'user') return false;
  return file.path === 'Welcome.md' && !syncedBase(file) && !file.remoteSha;
}

export function shouldAutoUpload(file) {
  if (!file || file.kind !== 'markdown' || isIgnoredPath(file.path)) return false;
  if (file.trashedAt || file.conflictCopy || file.backup || file.conflict === true) return false;
  if (file.localOnly === true || isAppGenerated(file) || isLocalCopyName(file.path)) return false;
  if (file.origin === 'user') return true;
  return file.dirty === true;
}

// The commit a missing note was last seen at with the phone's exact blob: the
// previous synced head when the cursor recorded that blob there, otherwise
// the note's own synced commit. Empty when the phone cannot say.
export function deleteAncestor(file, context = {}) {
  if (!file) return '';
  const base = typeof file.baseSha === 'string' ? file.baseSha : '';
  const lastBlobs = context.lastBlobs;
  if (lastBlobs && typeof lastBlobs === 'object') {
    if (lastBlobs[file.path] !== base) return '';
    return context.cursorHead || file.syncedCommit || '';
  }
  return file.syncedCommit || '';
}

// A note GitHub no longer lists is removed only when the head that dropped it
// descends from the commit where the phone last saw exactly its blob. History
// is walked through every parent, so a merge commit whose first parent never
// had the note cannot remove it, and commit dates are never compared.
export function remoteDeleteDecision(file, context = {}) {
  if (!file || file.trashedAt || file.conflict || file.conflictCopy || file.dirty) return 'keep';
  if (isIgnoredPath(file.path)) return 'keep';
  const base = typeof file.baseSha === 'string' ? file.baseSha : '';
  const remote = typeof file.remoteSha === 'string' ? file.remoteSha : '';
  if (!base) return 'keep';
  const headSha = context.headSha || '';
  const synced = file.syncedCommit || '';
  if (synced && headSha && synced === headSha) return 'keep';
  if (base !== remote || !headSha) return 'conflict';
  const ancestor = deleteAncestor(file, context);
  if (!ancestor) return 'conflict';
  if (ancestor === headSha) return 'keep';
  const descends = context.descends instanceof Map ? context.descends.get(ancestor) : undefined;
  if (descends === true) return 'remove';
  if (descends === false) return 'conflict';
  return 'keep';
}

export function shouldRemoveLocal(file, context = {}) {
  return remoteDeleteDecision(file, context) === 'remove';
}

function blobsFromNotes(remoteNotes) {
  const blobs = {};
  for (const note of remoteNotes || []) {
    if (note && note.localPath && note.sha) blobs[note.localPath] = note.sha;
  }
  return blobs;
}

export const ANCESTRY_LIMIT = 200;

// Walks parents from head with the Git Data commit read the sync already uses.
// Returns true or false, or null when GitHub could not answer.
export async function commitDescendsFrom(readCommit, headSha, ancestor, limit = ANCESTRY_LIMIT) {
  if (!headSha || !ancestor) return false;
  if (headSha === ancestor) return true;
  const queue = [headSha];
  const seen = new Set();
  while (queue.length && seen.size < limit) {
    const sha = queue.shift();
    if (seen.has(sha)) continue;
    seen.add(sha);
    const parents = await readCommit(sha);
    if (parents == null) return null;
    for (const parent of parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return false;
}

function countCopies(files) {
  return (files || []).filter((file) => file && file.conflictCopy && !file.backup && !file.trashedAt && !isIgnoredPath(file.path)).length;
}

function commitDateMs(body, fallback) {
  const raw = body && body.committer && body.committer.date;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function blockedCreatePaths(ops) {
  const blocked = new Set();
  for (const op of ops || []) {
    if (op.kind === 'rename' && op.from) blocked.add(op.from);
    if (op.kind === 'delete' && op.path) blocked.add(op.path);
  }
  return blocked;
}

export function reconcileNotes(files, remoteNotes, context = {}) {
  const listed = (remoteNotes || []).filter((note) => note && !isIgnoredPath(note.localPath));
  const remote = new Map(listed.map((note) => [note.localPath, note]));
  const localPaths = new Set((files || []).map((file) => file && file.path));
  const pushes = [];
  const pulls = [];
  const creates = [];
  const conflicts = [];
  const removals = [];
  const blocked = blockedCreatePaths(context.ops);
  for (const file of files || []) {
    if (!file || file.kind !== 'markdown' || file.trashedAt || file.conflictCopy || isIgnoredPath(file.path)) continue;
    const found = remote.get(file.path);
    const base = syncedBase(file);
    if (file.conflict === true) {
      conflicts.push({ path: file.path, reason: file.conflictReason || 'existing', remote: found || null });
      continue;
    }
    const dirty = file.dirty === true;
    if (dirty) {
      if (!found) {
        if (base) conflicts.push({ path: file.path, reason: 'deleted', remote: null });
        else if (shouldAutoUpload(file)) pushes.push(file);
      } else if (base && found.sha === base) {
        if (shouldAutoUpload(file) || (file.origin !== 'app' && !file.localOnly && !isLocalCopyName(file.path))) {
          pushes.push(file);
        }
      } else {
        conflicts.push({ path: file.path, reason: 'both', remote: found });
      }
      continue;
    }
    if (!found) {
      if (base) {
        const decision = remoteDeleteDecision(file, context);
        if (decision === 'remove') removals.push(file.path);
        else if (decision === 'conflict') conflicts.push({ path: file.path, reason: 'deleted', remote: null });
      } else if (shouldAutoUpload(file)) {
        pushes.push(file);
      }
      continue;
    }
    if (found.sha !== (file.remoteSha || base)) {
      pulls.push({ file, remote: found });
    }
  }
  for (const note of listed) {
    if (localPaths.has(note.localPath) || blocked.has(note.localPath)) continue;
    creates.push(note);
  }
  return { pushes, pulls, creates, conflicts, removals };
}

function arm(setTimer, fn, ms) {
  const id = setTimer(fn, ms);
  if (id && typeof id.unref === 'function') id.unref();
  return id;
}

export function createSyncClock({
  debounceMs = SYNC_DEBOUNCE_MS,
  pollMs = SYNC_POLL_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  onDebounced,
  onPoll,
} = {}) {
  let debounceId = null;
  let pollId = null;
  let stopped = false;

  function clearDebounce() {
    if (debounceId != null) clearTimer(debounceId);
    debounceId = null;
  }

  return {
    edited() {
      if (stopped) return;
      clearDebounce();
      debounceId = arm(setTimer, () => {
        debounceId = null;
        onDebounced?.();
      }, debounceMs);
    },
    flush() {
      if (stopped) return;
      clearDebounce();
      onDebounced?.();
    },
    start() {
      if (stopped || pollId != null) return;
      const tick = () => {
        if (stopped) return;
        onPoll?.();
        pollId = arm(setTimer, tick, pollMs);
      };
      pollId = arm(setTimer, tick, pollMs);
    },
    stop() {
      stopped = true;
      clearDebounce();
      if (pollId != null) clearTimer(pollId);
      pollId = null;
    },
  };
}

function repoUrl(repo, suffix) {
  return `https://api.github.com/repos/${repo}${suffix}`;
}

function readRef(body, branch) {
  const want = `refs/heads/${branch}`;
  if (!body || body.ref !== want) return '';
  const sha = body.object && body.object.sha;
  return typeof sha === 'string' ? sha : '';
}

function blobText(body) {
  if (!body || typeof body.content !== 'string') {
    throw new Error('GitHub left out the text of that note. Nothing was changed.');
  }
  if (body.encoding === 'utf-8') return body.content;
  if (body.encoding === 'base64') return decodeUtf8Base64(body.content);
  throw new Error('GitHub left out the text of that note. Nothing was changed.');
}

function commitParents(body) {
  if (!body || !Array.isArray(body.parents)) return [];
  return body.parents.map((parent) => parent && parent.sha).filter((sha) => typeof sha === 'string' && sha);
}

// GitHub's current text for one path: ref, commit, tree, blob. Null when the
// branch no longer has the note or GitHub could not answer.
export async function fetchRemoteBlob(fetchImpl, settings, path, { signal } = {}) {
  if (!settings || !settings.token || !settings.repo || !settings.branch || !path) return null;
  if (isIgnoredPath(path)) return null;
  const call = (url) => request(fetchImpl, settings.token, url, signal ? { signal } : {});
  const ref = await call(repoUrl(settings.repo, refReadPath(settings.branch)));
  const headSha = ref.ok ? readRef(ref.body, settings.branch) : '';
  if (!headSha) return null;
  const commit = await call(repoUrl(settings.repo, `/git/commits/${headSha}`));
  const treeSha = commit.ok && commit.body && commit.body.tree ? commit.body.tree.sha : '';
  if (typeof treeSha !== 'string' || !treeSha) return null;
  const tree = await call(repoUrl(settings.repo, `/git/trees/${treeSha}?recursive=1`));
  if (!tree.ok) return null;
  let notes = [];
  try {
    notes = selectMarkdown(tree.body, settings.root);
  } catch {
    return null;
  }
  const found = notes.find((note) => note.localPath === path);
  if (!found) return null;
  const blob = await call(repoUrl(settings.repo, `/git/blobs/${found.sha}`));
  if (!blob.ok) return null;
  return { sha: found.sha, text: blobText(blob.body) };
}

export const REMOTE_TEXT = {
  offline: { title: "GitHub's version isn't available offline", hint: "Connect to the internet and tap Try again, or keep this phone's text." },
  timeout: { title: 'GitHub took too long to answer', hint: 'Check the connection and tap Try again.' },
  failed: { title: "GitHub's version couldn't be loaded", hint: "Tap Try again, or keep this phone's text." },
};

function unavailable(file, state) {
  const text = REMOTE_TEXT[state] || REMOTE_TEXT.failed;
  return { file, source: '', state, title: text.title, hint: text.hint, reason: `${text.title}. ${text.hint}` };
}

class RemoteTimeout extends Error {}

// Gives up after `timeoutMs` even if the request ignores the abort signal.
async function withTimeout(run, { timeoutMs, setTimer, clearTimer }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const expired = new Promise((resolve, reject) => {
    timer = setTimer(() => {
      if (controller) controller.abort();
      reject(new RemoteTimeout('GitHub took too long to answer.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller ? controller.signal : undefined), expired]);
  } finally {
    clearTimer(timer);
  }
}

// The GitHub side for a conflict recorded before v26, which has no stored text.
// Online it is GitHub's current blob for that path; otherwise the exactly
// matched conflict copy. Neither leaves `reason` and `state` set and the file
// unchanged, so the screen can offer Try again instead of a guessed diff.
export async function loadConflictRemote({
  db,
  file,
  sibling = null,
  fetchImpl = globalThis.fetch,
  offline = () => false,
  timeoutMs = REMOTE_LOAD_TIMEOUT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  if (!file) return { file: null, source: '', state: 'missing', reason: 'That note is not on this device.' };
  if (hasConflictRemote(file)) return { file, source: 'stored', state: '', reason: '' };
  let state = offline() ? 'offline' : '';
  if (!state) {
    try {
      const settings = await loadGithubSettings(db);
      const fetched = await withTimeout((signal) => fetchRemoteBlob(fetchImpl, settings, file.path, { signal }), {
        timeoutMs,
        setTimer,
        clearTimer,
      });
      if (fetched) {
        return {
          file: { ...file, conflictRemote: fetched.text, conflictRemoteSha: fetched.sha, conflictRemoteKnown: true },
          source: 'github',
          state: '',
          reason: '',
        };
      }
      state = 'failed';
    } catch (error) {
      state = error instanceof RemoteTimeout ? 'timeout' : 'failed';
    }
  }
  if (sibling && typeof sibling.content === 'string') {
    return {
      file: { ...file, conflictRemote: sibling.content, conflictRemoteKnown: true, conflictCopyPath: sibling.path },
      source: 'copy',
      state: '',
      reason: '',
    };
  }
  return unavailable(file, offline() ? 'offline' : state);
}

export const SYNC_REQUEST_TIMEOUT_MS = 15000;
export const SYNC_BLOB_TIMEOUT_MS = 60000;
// A run with no request starting or settling for this long is given up so
// the next poll can start. Longer than any single request may take.
export const SYNC_STALL_MS = 90000;

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

// Every sync request, body included, settles within its limit. The abort
// stops the network read; the race covers a fetch that ignores the signal.
export function timedFetch(fetchImpl, {
  timeoutMs = SYNC_REQUEST_TIMEOUT_MS,
  blobTimeoutMs = SYNC_BLOB_TIMEOUT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  onActivity = () => {},
} = {}) {
  return async (url, init = {}) => {
    const limit = /\/git\/blobs\/[^/?]+/.test(String(url)) ? Math.max(timeoutMs, blobTimeoutMs) : timeoutMs;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    const expired = new Promise((resolve, reject) => {
      timer = setTimer(() => {
        if (controller) controller.abort();
        const error = new Error('GitHub took too long to answer.');
        error.timedOut = true;
        reject(error);
      }, limit);
    });
    const run = (async () => {
      const response = await fetchImpl(url, controller ? { ...init, signal: controller.signal } : init);
      const body = NULL_BODY.has(response.status) ? null : await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    })();
    onActivity();
    try {
      return await Promise.race([run, expired]);
    } finally {
      clearTimer(timer);
      run.catch(() => {});
      onActivity();
    }
  };
}

async function request(fetchImpl, token, url, options = {}) {
  return githubRequest(fetchImpl, url, { token, secrets: [token], ...options });
}

function limited(result) {
  return retryDelay({ status: result.status, headers: result.headers || {} }) > 0
    && (result.status === 429 || (result.status === 403 && header(result.headers, 'x-ratelimit-remaining') === '0'));
}

export function createAutoSync({
  db,
  fetchImpl: rawFetch = globalThis.fetch,
  now = () => Date.now(),
  random = Math.random,
  debounceMs = SYNC_DEBOUNCE_MS,
  pollMs = SYNC_POLL_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  offline = () => false,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  authRecheckMs = AUTH_RECHECK_MS,
  requestTimeoutMs = SYNC_REQUEST_TIMEOUT_MS,
  blobTimeoutMs = SYNC_BLOB_TIMEOUT_MS,
  stallMs = SYNC_STALL_MS,
  beforeSync = async () => {},
  onStatus = () => {},
  onApplied = () => {},
  onPulled = () => {},
  onRemoved = () => {},
} = {}) {
  let chain = Promise.resolve();
  let state = { configured: false, confirmed: false };
  let activity = 0;
  let quietRetries = 0;
  let retryTimer = null;
  const fetchImpl = timedFetch(rawFetch, {
    timeoutMs: requestTimeoutMs,
    blobTimeoutMs,
    setTimer,
    clearTimer,
    onActivity: () => {
      activity += 1;
    },
  });
  let stopped = false;
  let prepared = null;

  function publish(next) {
    state = { ...state, ...next };
    const text = presentSyncStatus(state);
    onStatus(text, state);
    return { ...state, status: text };
  }

  async function finish(partial) {
    let copies = partial && partial.copies;
    if (copies == null) copies = countCopies(await listFiles(db));
    return publish({
      configured: true,
      authRequired: false,
      conflict: false,
      offline: false,
      failed: false,
      syncing: false,
      pending: false,
      retrying: false,
      confirmed: false,
      detail: '',
      copies,
      ...partial,
    });
  }

  async function ensureOp(file, settings) {
    const op = {
      id: file.path,
      repo: settings.repo,
      branch: settings.branch,
      path: file.path,
      baseSha: syncedBase(file),
      enqueuedAt: now(),
      attempts: 0,
      nextAttemptAt: 0,
    };
    const existing = (await listOps(db)).find((item) => item.id === file.path);
    if (existing && (existing.kind === 'delete' || existing.kind === 'rename')) return existing;
    if (existing) {
      op.attempts = existing.attempts || 0;
      op.nextAttemptAt = existing.nextAttemptAt || 0;
      op.enqueuedAt = existing.enqueuedAt || op.enqueuedAt;
      if (existing.kind) op.kind = existing.kind;
    }
    await putOp(db, op);
    return op;
  }

  async function noteEdited(file) {
    if (!file || !file.path || file.conflictCopy || file.backup || file.trashedAt || isIgnoredPath(file.path)) return;
    if (file.localOnly || isAppGenerated(file) || isLocalCopyName(file.path)) return;
    const settings = await loadGithubSettings(db);
    if (!settings.token || !settings.repo || !settings.branch) return;
    await ensureOp({ ...file, dirty: true }, settings);
    publish({ configured: true, pending: true, confirmed: false, syncing: false });
    clock.edited();
  }

  async function noteTrashed({ file, baseSha }) {
    if (!file || !file.path || file.conflictCopy || file.backup || isIgnoredPath(file.path)) return;
    const settings = await loadGithubSettings(db);
    if (!settings.token || !settings.repo || !settings.branch) return;
    if (!baseSha) {
      await deleteOps(db, [file.path]);
      return;
    }
    await putOp(db, {
      id: file.path,
      kind: 'delete',
      repo: settings.repo,
      branch: settings.branch,
      path: file.path,
      baseSha,
      enqueuedAt: now(),
      attempts: 0,
      nextAttemptAt: 0,
    });
    publish({ configured: true, pending: true, confirmed: false, syncing: false });
    clock.edited();
  }

  async function noteRenamed({ from, to, baseSha, file }) {
    if (!file || !to || isIgnoredPath(to) || (from && isIgnoredPath(from))) return;
    const settings = await loadGithubSettings(db);
    if (!settings.token || !settings.repo || !settings.branch) return;
    await deleteOps(db, [from, to]);
    if (!baseSha) {
      await ensureOp(file, settings);
    } else {
      await putOp(db, {
        id: to,
        kind: 'rename',
        repo: settings.repo,
        branch: settings.branch,
        path: to,
        from,
        to,
        baseSha,
        enqueuedAt: now(),
        attempts: 0,
        nextAttemptAt: 0,
      });
    }
    publish({ configured: true, pending: true, confirmed: false, syncing: false });
    clock.edited();
  }

  async function forgetRemote(path) {
    const leftover = await getFile(db, path);
    if (!leftover) return null;
    const next = {
      ...leftover,
      baseSha: null,
      remoteSha: null,
      syncedAt: null,
      syncedCommit: '',
      origin: leftover.origin || 'user',
    };
    await putFile(db, next);
    return next;
  }

  async function noteRestored(file) {
    if (!file || !file.path || isIgnoredPath(file.path)) return;
    const settings = await loadGithubSettings(db);
    const ops = await listOps(db);
    const queuedDelete = ops.find((op) => (op.id === file.path || op.path === file.path) && op.kind === 'delete');
    if (queuedDelete) {
      await deleteOps(db, [file.path]);
      return;
    }
    await deleteOps(db, [file.path]);
    if (!settings.token || !settings.repo || !settings.branch) return;
    if (file.conflictCopy || file.backup || file.localOnly || isAppGenerated(file) || isLocalCopyName(file.path)) {
      return;
    }
    const hadBase = Boolean(syncedBase(file));
    const userNote = file.origin === 'user' || hadBase || (!isAppGenerated(file) && !file.localOnly);
    if (!userNote) return;
    const next = {
      ...file,
      dirty: true,
      baseSha: null,
      remoteSha: null,
      origin: 'user',
      localOnly: false,
      trashedAt: null,
      syncedAt: null,
      syncedCommit: '',
    };
    await putFile(db, next);
    await ensureOp(next, settings);
    onApplied([next]);
    publish({ configured: true, pending: true, confirmed: false, syncing: false });
    clock.edited();
  }

  async function syncOnce(reason) {
    if (stopped) return finish(state);
    try {
      await beforeSync();
    } catch {
      // The note stays on screen. Sync tries again with whatever was saved.
    }
    const settings = await loadGithubSettings(db);
    const configured = Boolean(settings.token && settings.repo && settings.branch);
    if (!configured) return finish({ configured: false, syncing: false, confirmed: false });
    const ops = await listOps(db);
    const pending = ops.some((op) => op.repo === settings.repo && op.branch === settings.branch);
    if (offline()) {
      const conflicted = await hasConflict();
      return finish({ offline: true, pending, syncing: false, conflict: conflicted });
    }
    publish({ configured: true, offline: false, syncing: true, pending, failed: false, authRequired: false });
    try {
      const result = await perform(settings, ops, reason, finish);
      quietRetries = 0;
      return result;
    } catch (error) {
      const message = redact(error && error.message ? error.message : '', [settings.token]);
      const conflicted = await hasConflict();
      if (error && error.timedOut) {
        retryLater();
        return finish({
          syncing: false,
          pending: true,
          retrying: true,
          conflict: conflicted,
        });
      }
      const reached = message.includes('could not be reached') || message.includes('offline');
      if (reached) retryLater();
      return finish({
        syncing: false,
        offline: reached || offline(),
        failed: !reached && !conflicted,
        pending: true,
        conflict: conflicted,
      });
    }
  }

  // A slow or lost answer retries on a growing delay. The queue and the
  // notes are kept, and the regular poll keeps running beside it.
  function retryLater() {
    if (stopped) return;
    if (retryTimer) clearTimer(retryTimer);
    const wait = backoffDelay(quietRetries, random);
    quietRetries += 1;
    retryTimer = arm(setTimer, () => {
      retryTimer = null;
      queue('retry');
    }, wait);
  }

  // The next run never waits on one that stopped making progress. Each
  // request has its own limit, so this only trips on a wait outside them.
  function watched(reason) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let seen = activity;
      let timer = null;
      const check = () => {
        if (settled) return;
        if (activity !== seen) {
          seen = activity;
          timer = arm(setTimer, check, stallMs);
          return;
        }
        settled = true;
        retryLater();
        resolve(publish({ configured: true, syncing: false, pending: true, retrying: true, offline: false, failed: false }));
      };
      timer = arm(setTimer, check, stallMs);
      syncOnce(reason).then((value) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve(value);
      }, (error) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        reject(error);
      });
    });
  }

  function queue(reason) {
    const job = chain.then(() => watched(reason));
    chain = job.then(() => {}, () => {});
    return job;
  }

  const clock = createSyncClock({
    debounceMs,
    pollMs,
    setTimer,
    clearTimer,
    onDebounced: () => queue('edit'),
    onPoll: () => queue('poll'),
  });

  async function perform(settings, ops, reason, finish, racePass = 0) {
    const token = settings.token;
    const call = (url, options) => request(fetchImpl, token, url, options);
    const ignored = ops.filter((op) => isIgnoredPath(op.path) || (op.from && isIgnoredPath(op.from)));
    if (ignored.length) {
      await deleteOps(db, ignored.map((op) => op.id));
      ops = ops.filter((op) => !ignored.includes(op));
    }
    const localNotes = await listFiles(db);
    const dirtyFiles = localNotes.filter((file) => file && file.dirty && !file.trashedAt && !file.conflictCopy && file.kind === 'markdown' && !isIgnoredPath(file.path));
    for (const file of dirtyFiles) {
      if (!ops.some((op) => op.id === file.path)) ops.push(await ensureOp(file, settings));
    }
    const refUrl = repoUrl(settings.repo, refReadPath(settings.branch));
    const updateUrl = repoUrl(settings.repo, refUpdatePath(settings.branch));
    const cursor = await getMeta(db, CURSOR_KEY);
    const samePlace = cursor && cursor.repo === settings.repo && cursor.branch === settings.branch && (cursor.root || '') === (settings.root || '');
    const savedEtag = samePlace ? cursor.etag || '' : '';
    const previousBlobs = samePlace && cursor.lastBlobs && typeof cursor.lastBlobs === 'object' ? cursor.lastBlobs : null;
    const previousHead = samePlace && previousBlobs ? cursor.headSha || '' : '';
    const parentsOf = new Map();

    let ref = await call(refUrl, { etag: savedEtag });
    if (ref.status === 401) return authOrFail(settings, ops);
    if (limited(ref)) {
      const wait = retryDelay({ status: ref.status, headers: ref.headers, now: now(), random });
      return scheduleRetry(settings, ops, wait);
    }
    if (ref.status === 404) {
      return finish({ configured: true, failed: true, syncing: false, confirmed: false, pending: ops.length > 0 });
    }
    if (ref.status !== 304 && !ref.ok) {
      if (ref.status === 0) {
        return finish({ configured: true, offline: true, syncing: false, confirmed: false, pending: ops.length > 0 });
      }
      const wait = retryDelay({ status: ref.status, headers: ref.headers, attempt: 0, now: now(), random });
      if (wait) return scheduleRetry(settings, ops, wait);
      return finish({ configured: true, failed: true, syncing: false, confirmed: false, pending: ops.length > 0 });
    }

    let headSha = '';
    let treeSha = '';
    let headDate = 0;
    if (ref.status === 304 && samePlace && cursor.headSha && cursor.treeSha) {
      headSha = cursor.headSha;
      treeSha = cursor.treeSha;
      headDate = Number(cursor.headDate) || 0;
    } else {
      headSha = readRef(ref.body, settings.branch);
      if (!headSha) {
        return finish({ configured: true, failed: true, syncing: false, confirmed: false, pending: ops.length > 0 });
      }
      const commit = await call(repoUrl(settings.repo, `/git/commits/${headSha}`));
      if (commit.status === 401) return authOrFail(settings, ops);
      if (!commit.ok || !commit.body || !commit.body.tree || typeof commit.body.tree.sha !== 'string') {
        return hold(settings, ops, commit);
      }
      treeSha = commit.body.tree.sha;
      headDate = commitDateMs(commit.body, now());
      parentsOf.set(headSha, commitParents(commit.body));
    }

    const mine = ops.filter((op) => op.path && op.repo === settings.repo && op.branch === settings.branch);
    const ready = reason === 'flush' || reason === 'online'
      ? mine
      : mine.filter((op) => !op.nextAttemptAt || op.nextAttemptAt <= now());

    if (ref.status === 304 && ready.length === 0) {
      const files = await listFiles(db);
      const unsentLocal = files.some((file) => shouldAutoUpload(file) && !file.dirty && !syncedBase(file) && !file.remoteSha);
      if (unsentLocal) {
        // A user-created note that has never been synced still needs the tree, not a 304 stop.
      } else {
      const conflicted = files.some(openConflict);
      await setMeta(db, CURSOR_KEY, {
        repo: settings.repo,
        branch: settings.branch,
        root: settings.root || '',
        etag: savedEtag,
        headSha,
        treeSha,
        headDate,
        lastBlobs: previousBlobs,
      });
      return finish({
        configured: true,
        syncing: false,
        confirmed: !conflicted,
        conflict: conflicted,
        pending: mine.length > 0 && ready.length === 0,
        failed: false,
        offline: false,
        copies: countCopies(files),
      });
      }
    }

    const tree = await call(repoUrl(settings.repo, `/git/trees/${treeSha}?recursive=1`));
    if (tree.status === 401) return authOrFail(settings, ops);
    if (!tree.ok) return hold(settings, ops, tree);
    let remoteNotes = [];
    try {
      remoteNotes = selectMarkdown(tree.body, settings.root);
    } catch {
      return finish({ configured: true, failed: true, syncing: false, confirmed: false, pending: mine.length > 0 });
    }
    const files = await listFiles(db);
    const listed = new Set(remoteNotes.map((note) => note.localPath));
    const descends = new Map();
    let unreadCommit = null;
    const readCommit = async (sha) => {
      if (parentsOf.has(sha)) return parentsOf.get(sha);
      const read = await call(repoUrl(settings.repo, `/git/commits/${encodeURIComponent(sha)}`));
      if (!read.ok) {
        unreadCommit = read;
        return null;
      }
      const parents = commitParents(read.body);
      parentsOf.set(sha, parents);
      return parents;
    };
    const deleteContext = { headSha, lastBlobs: previousBlobs, cursorHead: previousHead };
    for (const file of files) {
      if (!file || file.kind !== 'markdown' || file.trashedAt || file.conflictCopy || file.conflict || file.dirty) continue;
      if (listed.has(file.path) || !syncedBase(file) || isIgnoredPath(file.path)) continue;
      const ancestor = deleteAncestor(file, deleteContext);
      if (!ancestor || ancestor === headSha || descends.has(ancestor)) continue;
      const answer = await commitDescendsFrom(readCommit, headSha, ancestor);
      // Without an answer nothing is removed and the cursor is not moved, so
      // the next sync asks again from the same place.
      if (answer === null) return hold(settings, ops, unreadCommit || { status: 0 });
      descends.set(ancestor, answer);
    }
    const plan = reconcileNotes(files, remoteNotes, {
      ...deleteContext,
      descends,
      ops: mine,
    });
    const seenBlobs = blobsFromNotes(remoteNotes);
    await setMeta(db, CURSOR_KEY, {
      repo: settings.repo,
      branch: settings.branch,
      root: settings.root || '',
      etag: ref.etag || savedEtag,
      headSha,
      treeSha,
      headDate,
      lastBlobs: seenBlobs,
    });
    const applied = [];
    let pulled = false;
    for (const item of plan.pulls) {
      const fresh = await getFile(db, item.file.path);
      if (!fresh || fresh.dirty || fresh.conflict) continue;
      const blob = await call(repoUrl(settings.repo, `/git/blobs/${item.remote.sha}`));
      if (!blob.ok) return hold(settings, ops, blob);
      const text = blobText(blob.body);
      const next = {
        ...fresh,
        content: text,
        remoteSha: item.remote.sha,
        baseSha: item.remote.sha,
        dirty: false,
        conflict: false,
        updatedAt: now(),
        syncedAt: headDate || now(),
        syncedCommit: headSha,
        localOnly: false,
        origin: fresh.origin === 'app' ? '' : fresh.origin,
      };
      await putFile(db, next);
      await deleteOps(db, [fresh.path]);
      applied.push(next);
      pulled = true;
    }
    for (const note of plan.creates) {
      const blob = await call(repoUrl(settings.repo, `/git/blobs/${note.sha}`));
      if (!blob.ok) return hold(settings, ops, blob);
      const text = blobText(blob.body);
      const created = {
        path: note.localPath,
        content: text,
        kind: 'markdown',
        encoding: 'utf-8',
        createdAt: now(),
        updatedAt: now(),
        trashedAt: null,
        remoteSha: note.sha,
        baseSha: note.sha,
        dirty: false,
        conflict: false,
        syncedAt: headDate || now(),
        syncedCommit: headSha,
      };
      const already = await getFile(db, created.path);
      if (already) continue;
      await putFile(db, created);
      applied.push(created);
      pulled = true;
    }

    const removed = [];
    for (const path of plan.removals || []) {
      await commitFiles(db, { remove: [path] });
      await deleteOps(db, [path]);
      removed.push(path);
    }
    if (removed.length) onRemoved(removed);

    const extraPushes = [];
    const taken = new Set((await listFiles(db)).map((file) => file.path));
    let conflicted = false;
    async function keepConflict(fresh, { reason, copy, remoteSha = '', baseText = '' }) {
      const siblingPath = conflictCopyPath(fresh.path, now(), taken);
      taken.add(siblingPath);
      const sibling = {
        path: siblingPath,
        content: copy,
        kind: 'markdown',
        encoding: 'utf-8',
        createdAt: now(),
        updatedAt: now(),
        trashedAt: null,
        remoteSha: null,
        baseSha: null,
        dirty: false,
        conflict: false,
        conflictCopy: true,
        origin: 'app',
      };
      const marked = {
        ...fresh,
        conflict: true,
        dirty: true,
        conflictAt: now(),
        conflictRemoteAt: headDate || now(),
        conflictReason: reason,
        conflictRemote: copy,
        conflictRemoteSha: remoteSha,
        conflictRemoteKnown: true,
        conflictBase: baseText,
        conflictCopyPath: siblingPath,
      };
      await putFile(db, sibling);
      await putFile(db, marked);
      await ensureOp(marked, settings);
      applied.push(sibling, marked);
      conflicted = true;
      return marked;
    }
    for (const item of plan.conflicts) {
      const fresh = await getFile(db, item.path);
      if (!fresh) continue;
      if (fresh.conflict === true) {
        conflicted = true;
        continue;
      }
      let copy = DELETED_COPY;
      let baseText = '';
      let baseKnown = false;
      if (item.remote && item.remote.sha) {
        const blob = await call(repoUrl(settings.repo, `/git/blobs/${item.remote.sha}`));
        if (!blob.ok) return hold(settings, ops, blob);
        copy = blobText(blob.body);
        const base = syncedBase(fresh);
        if (base && base !== item.remote.sha) {
          const baseBlob = await call(repoUrl(settings.repo, `/git/blobs/${base}`));
          if (baseBlob.status === 404) baseKnown = false;
          else if (!baseBlob.ok) return hold(settings, ops, baseBlob);
          else {
            baseText = blobText(baseBlob.body);
            baseKnown = true;
          }
        }
        const merged = baseKnown
          ? merge3(baseText, String(fresh.content ?? ''), copy)
          : merge2(String(fresh.content ?? ''), copy);
        if (merged.auto) {
          const same = merged.text === copy;
          const next = {
            ...fresh,
            content: merged.text,
            remoteSha: same ? item.remote.sha : fresh.remoteSha,
            baseSha: item.remote.sha,
            dirty: !same,
            conflict: false,
            conflictRemote: '',
            conflictBase: '',
            conflictReason: '',
            syncedAt: same ? (headDate || now()) : fresh.syncedAt,
            syncedCommit: same ? headSha : fresh.syncedCommit,
            localOnly: false,
          };
          await putFile(db, next);
          if (same) await deleteOps(db, [fresh.path]);
          else {
            await ensureOp(next, settings);
            extraPushes.push(next);
          }
          applied.push(next);
          continue;
        }
      }
      await keepConflict(fresh, {
        reason: item.reason === 'existing' ? 'legacy' : item.reason,
        copy,
        remoteSha: item.remote && item.remote.sha ? item.remote.sha : '',
        baseText,
      });
    }

    const deletions = [];
    const mineNow = (await listOps(db)).filter((op) => op.repo === settings.repo && op.branch === settings.branch);
    const readyIds = new Set(ready.map((op) => op.id));
    for (const op of mineNow) {
      if (!readyIds.has(op.id)) continue;
      if (op.kind === 'delete') {
        if (!op.baseSha) {
          await deleteOps(db, [op.path]);
          continue;
        }
        const remoteNote = remoteNotes.find((note) => note.localPath === op.path);
        if (!remoteNote) {
          await deleteOps(db, [op.path]);
          const forgotten = await forgetRemote(op.path);
          if (forgotten) applied.push(forgotten);
          continue;
        }
        if (remoteNote.sha === op.baseSha) {
          deletions.push({ path: op.path });
          continue;
        }
        const blob = await call(repoUrl(settings.repo, `/git/blobs/${remoteNote.sha}`));
        if (!blob.ok) return hold(settings, ops, blob);
        const fresh = await getFile(db, op.path);
        if (fresh) {
          await keepConflict({ ...fresh, trashedAt: null }, {
            reason: 'delete',
            copy: blobText(blob.body),
            remoteSha: remoteNote.sha,
            baseText: '',
          });
        }
        await deleteOps(db, [op.path]);
        continue;
      }
      if (op.kind === 'rename') {
        const remoteNote = op.baseSha ? remoteNotes.find((note) => note.localPath === op.from) : null;
        if (!op.baseSha || !remoteNote) continue;
        if (remoteNote.sha === op.baseSha) {
          deletions.push({ path: op.from });
          continue;
        }
        const blob = await call(repoUrl(settings.repo, `/git/blobs/${remoteNote.sha}`));
        if (!blob.ok) return hold(settings, ops, blob);
        const text = blobText(blob.body);
        const restored = {
          path: op.from,
          content: text,
          kind: 'markdown',
          encoding: 'utf-8',
          createdAt: now(),
          updatedAt: now(),
          trashedAt: null,
          remoteSha: remoteNote.sha,
          baseSha: remoteNote.sha,
          dirty: false,
          conflict: false,
        };
        await putFile(db, restored);
        applied.push(restored);
        const fresh = await getFile(db, op.to);
        if (fresh) {
          await keepConflict(fresh, { reason: 'rename', copy: text, remoteSha: remoteNote.sha, baseText: '' });
        }
        await deleteOps(db, [op.id]);
      }
    }

    const pushFiles = [];
    for (const file of plan.pushes) {
      const fresh = await getFile(db, file.path);
      if (!fresh || fresh.conflict || fresh.conflictCopy || fresh.trashedAt) continue;
      const queued = ready.some((op) => op.path === fresh.path || op.id === fresh.path);
      if (!queued && !(shouldAutoUpload(fresh) && !fresh.dirty && !syncedBase(fresh) && !fresh.remoteSha)) continue;
      if (!queued) await ensureOp(fresh, settings);
      pushFiles.push(fresh);
    }
    for (const file of extraPushes) {
      const fresh = await getFile(db, file.path);
      if (!fresh || fresh.conflict || fresh.conflictCopy || fresh.trashedAt) continue;
      if (pushFiles.some((item) => item.path === fresh.path)) continue;
      pushFiles.push(fresh);
    }

    if (applied.length) onApplied(applied);
    if (pulled) {
      try {
        await onPulled();
      } catch {
        // The notes are saved. Images can be fetched on the next sync.
      }
    }

    if (!pushFiles.length && !deletions.length) {
      const still = (await listOps(db)).some((op) => op.repo === settings.repo && op.branch === settings.branch);
      return finish({
        configured: true,
        syncing: false,
        conflict: conflicted,
        pending: still && !conflicted,
        confirmed: !conflicted && !still,
        failed: false,
        offline: false,
      });
    }

    // Another client moved the branch. Nothing was written yet; wait and run
    // the whole pass again on the new head, so each note merges against it.
    async function raced() {
      prepared = null;
      const queued = await listOps(db);
      if (racePass >= RACE_RETRY_LIMIT) {
        const attempt = queued.reduce((max, op) => Math.max(max, op.attempts || 0), 0);
        return scheduleRetry(settings, queued, backoffDelay(attempt, random));
      }
      await sleep(raceDelay(racePass, random));
      return perform(settings, queued, reason, finish, racePass + 1);
    }

    const again = await call(refUrl);
    if (again.status === 401) return authOrFail(settings, ops);
    if (!again.ok) return hold(settings, ops, again);
    const freshHead = readRef(again.body, settings.branch);
    if (!freshHead) return hold(settings, ops, again);
    if (freshHead !== headSha) return raced();

    const key = preparedKey(freshHead, pushFiles, deletions);
    let written = prepared && prepared.key === key ? prepared.written : null;
    let commitSha = written ? prepared.commitSha : '';
    if (!written) {
      const entries = [];
      written = [];
      for (const file of pushFiles) {
        if (isIgnoredPath(file.path)) continue;
        const blob = await call(repoUrl(settings.repo, '/git/blobs'), {
          method: 'POST',
          body: { content: String(file.content ?? ''), encoding: 'utf-8' },
        });
        if (!blob.ok || !blob.body || typeof blob.body.sha !== 'string') return hold(settings, ops, blob);
        entries.push({
          path: repoPath(settings.root, file.path),
          mode: '100644',
          type: 'blob',
          sha: blob.body.sha,
        });
        written.push({ path: file.path, sha: blob.body.sha, content: String(file.content ?? '') });
      }
      for (const item of deletions) {
        if (isIgnoredPath(item.path)) continue;
        entries.push({
          path: repoPath(settings.root, item.path),
          mode: '100644',
          type: 'blob',
          sha: null,
        });
      }
      const treeWrite = await call(repoUrl(settings.repo, '/git/trees'), {
        method: 'POST',
        body: { base_tree: treeSha, tree: entries },
      });
      if (!treeWrite.ok || !treeWrite.body || typeof treeWrite.body.sha !== 'string') return hold(settings, ops, treeWrite);
      const commitWrite = await call(repoUrl(settings.repo, '/git/commits'), {
        method: 'POST',
        body: {
          message: commitMessage(written.map((item) => item.path), deletions.map((item) => item.path)),
          tree: treeWrite.body.sha,
          parents: [freshHead],
        },
      });
      if (!commitWrite.ok || !commitWrite.body || typeof commitWrite.body.sha !== 'string') {
        return hold(settings, ops, commitWrite);
      }
      commitSha = commitWrite.body.sha;
      prepared = {
        key,
        commitSha,
        written,
        treeSha: treeWrite.body.sha,
        headDate: commitDateMs(commitWrite.body, now()),
      };
    }
    const update = refUpdateBody(commitSha);
    if (update.force !== false) {
      return finish({ configured: true, failed: true, syncing: false, confirmed: false, pending: true });
    }
    const patched = await call(updateUrl, { method: 'PATCH', body: update });
    if (patched.status === 422 || patched.status === 409) return raced();
    const patchedSha = patched.body && patched.body.object && patched.body.object.sha;
    if (!patched.ok || patchedSha !== commitSha) return hold(settings, ops, patched);
    const writtenTreeSha = prepared && prepared.treeSha ? prepared.treeSha : treeSha;
    const writtenDate = prepared && prepared.headDate ? prepared.headDate : now();
    prepared = null;
    const writtenBlobs = { ...seenBlobs };
    for (const item of written) writtenBlobs[item.path] = item.sha;
    for (const item of deletions) delete writtenBlobs[item.path];
    await setMeta(db, CURSOR_KEY, {
      repo: settings.repo,
      branch: settings.branch,
      root: settings.root || '',
      etag: '',
      headSha: commitSha,
      treeSha: writtenTreeSha,
      headDate: writtenDate,
      lastBlobs: writtenBlobs,
    });

    const settled = [];
    for (const item of written) {
      const fresh = await getFile(db, item.path);
      if (!fresh) continue;
      if (String(fresh.content ?? '') !== item.content) {
        await ensureOp(fresh, settings);
        continue;
      }
      const next = {
        ...fresh,
        remoteSha: item.sha,
        baseSha: item.sha,
        dirty: false,
        conflict: false,
        syncedAt: writtenDate,
        syncedCommit: commitSha,
      };
      await putFile(db, next);
      await deleteOps(db, [fresh.path]);
      settled.push(next);
    }
    for (const item of deletions) {
      await deleteOps(db, [item.path]);
      const forgotten = await forgetRemote(item.path);
      if (forgotten) settled.push(forgotten);
    }
    if (settled.length) onApplied(settled);
    const remaining = await listOps(db);
    const stillPending = remaining.some((op) => op.repo === settings.repo && op.branch === settings.branch);
    const after = await listFiles(db);
    const stillConflict = after.some(openConflict);
    return finish({
      configured: true,
      syncing: false,
      confirmed: !stillPending && !stillConflict,
      pending: stillPending && !stillConflict,
      conflict: stillConflict,
      failed: false,
      offline: false,
      copies: countCopies(after),
    });
  }

  async function authOrFail(settings, ops) {
    const user = await readUser(fetchImpl, settings.token, { sleep, recheckMs: authRecheckMs });
    if (user.status === 401) {
      try {
        await recordAuthFailure(db, {
          at: now(),
          endpoint: 'GET /user',
          status: 401,
          message: user.message,
        }, [settings.token]);
      } catch {
        // The sign-in state below still shows. The record is only a hint.
      }
      return finish({
        configured: true,
        authRequired: true,
        syncing: false,
        confirmed: false,
        pending: ops.length > 0,
        failed: false,
      });
    }
    return finish({ configured: true, failed: true, syncing: false, confirmed: false, pending: ops.length > 0 });
  }

  async function scheduleRetry(settings, ops, wait) {
    const when = now() + wait;
    for (const op of ops) {
      if (op.repo !== settings.repo || op.branch !== settings.branch) continue;
      await putOp(db, { ...op, attempts: (op.attempts || 0) + 1, nextAttemptAt: when });
    }
    arm(setTimer, () => queue('retry'), wait);
    return finish({
      configured: true,
      syncing: false,
      retrying: true,
      pending: true,
      confirmed: false,
      failed: false,
    });
  }

  async function hold(settings, ops, result) {
    if (result && result.status === 401) return authOrFail(settings, ops);
    if (result && (limited(result) || result.status === 0 || result.status >= 500)) {
      const attempt = ops.reduce((max, op) => Math.max(max, op.attempts || 0), 0);
      const wait = retryDelay({
        status: result.status || 0,
        headers: result.headers || {},
        attempt,
        now: now(),
        random,
      }) || backoffDelay(attempt, random);
      return scheduleRetry(settings, ops, wait);
    }
    const message = result && result.message ? redact(result.message, [settings.token]) : githubStatusReason(result && result.status);
    const conflicted = await hasConflict();
    return finish({
      configured: true,
      failed: !conflicted,
      syncing: false,
      confirmed: false,
      pending: ops.length > 0,
      detail: message,
      conflict: conflicted,
    });
  }

  async function hasConflict() {
    const files = await listFiles(db);
    return files.some(openConflict);
  }

  async function refreshStatus() {
    const settings = await loadGithubSettings(db);
    const configured = Boolean(settings.token && settings.repo && settings.branch);
    if (!configured) return publish({ configured: false, syncing: false, confirmed: false, copies: 0 });
    const pending = (await listOps(db)).some((op) => op.repo === settings.repo && op.branch === settings.branch);
    const files = await listFiles(db);
    const conflicted = files.some(openConflict);
    const copies = countCopies(files);
    return publish({
      configured: true,
      authRequired: false,
      conflict: conflicted,
      offline: offline(),
      failed: false,
      syncing: false,
      pending: pending && !offline(),
      retrying: false,
      confirmed: !conflicted && !pending && !offline(),
      detail: '',
      copies,
    });
  }

  return {
    noteEdited,
    noteTrashed,
    noteRenamed,
    noteRestored,
    refreshStatus,
    flushNow() {
      clock.flush();
    },
    visible() {
      queue('visible');
    },
    online() {
      queue('online');
    },
    start() {
      clock.start();
      return queue('launch');
    },
    runNow(reason = 'manual') {
      return queue(reason);
    },
    stop() {
      stopped = true;
      clock.stop();
      if (retryTimer) clearTimer(retryTimer);
      retryTimer = null;
    },
    status() {
      return presentSyncStatus(state);
    },
  };
}

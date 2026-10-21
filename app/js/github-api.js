import { redact } from './github-redact.js';

export function cleanClientId(value) {
  const id = String(value ?? '').trim();
  if (!id) return '';
  if (/\s/.test(id) || id.includes('://') || id.length > 100) {
    throw new Error('That client id does not look right.');
  }
  return id;
}

export function cleanRelayUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The relay URL needs to be an https address.');
  }
  if (url.protocol !== 'https:') throw new Error('The relay URL needs to start with https.');
  if (url.username || url.password) throw new Error('The relay URL cannot include a password.');
  if (url.search || url.hash) throw new Error('The relay URL should be the worker address only.');
  return url.origin;
}

export function cleanRepo(value) {
  const repo = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Use owner/repo.');
  return repo;
}

export function cleanBranch(value) {
  const branch = String(value ?? '').trim();
  if (!branch || branch.startsWith('-') || /[\s~^:?*[\\]/.test(branch)) {
    throw new Error('Use a branch name.');
  }
  return branch;
}

export function cleanRoot(value) {
  const root = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!root) return '';
  if (root.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Use a folder path without ..');
  }
  return root;
}

export function relayEndpoint(relayUrl, which) {
  const base = cleanRelayUrl(relayUrl);
  if (!base) throw new Error('Add the relay URL first.');
  if (which === 'code') return `${base}/device/code`;
  if (which === 'token') return `${base}/oauth/access_token`;
  throw new Error('Unknown relay request.');
}

export function encodeUtf8Base64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeUtf8Base64(value) {
  const clean = String(value ?? '').replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function encodePath(path) {
  return String(path).split('/').map((part) => encodeURIComponent(part)).join('/');
}

export function repoPath(root, localPath) {
  const folder = cleanRoot(root);
  const local = String(localPath || '').replace(/^\/+/, '');
  if (!local || local.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('That note has no path.');
  }
  return folder ? `${folder}/${local}` : local;
}

export function contentsUrl(repo, path, branch) {
  const safeRepo = cleanRepo(repo);
  const ref = cleanBranch(branch);
  return `https://api.github.com/repos/${safeRepo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
}

export function treeUrl(repo, branch) {
  return `https://api.github.com/repos/${cleanRepo(repo)}/git/trees/${encodeURIComponent(cleanBranch(branch))}?recursive=1`;
}

export function repoUrl(repo) {
  return `https://api.github.com/repos/${cleanRepo(repo)}`;
}

export function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'core-sample',
  };
}

export function listVaultFiles(treeResponse, root, { allowTruncated = false } = {}) {
  if (!treeResponse || !Array.isArray(treeResponse.tree)) {
    throw new Error('GitHub did not list that branch.');
  }
  if (treeResponse.truncated && !allowTruncated) {
    throw new Error('That repository listing was cut off.');
  }
  const folder = cleanRoot(root);
  const paths = [];
  for (const item of treeResponse.tree) {
    if (!item || item.type !== 'blob' || typeof item.path !== 'string') continue;
    let local = item.path;
    if (folder) {
      const prefix = `${folder}/`;
      if (!item.path.startsWith(prefix)) continue;
      local = item.path.slice(prefix.length);
    }
    if (!local || local.split('/').some((part) => !part || part === '.' || part === '..')) continue;
    paths.push(local);
  }
  paths.sort((a, b) => a.localeCompare(b));
  return paths;
}

export async function fetchRawBytes(fetchImpl, { repo, path, branch, token }) {
  const url = contentsUrl(repo, path, branch);
  if (token && String(url).includes(token)) throw new Error('The request was refused.');
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github.raw',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'core-sample',
      },
      cache: 'no-store',
    });
  } catch {
    const error = new Error("Couldn't download (offline)");
    error.status = 0;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`Couldn't download (HTTP ${response.status})`);
    error.status = response.status || 0;
    throw error;
  }
  const bytes = await response.arrayBuffer();
  return { bytes, url };
}

export function selectMarkdown(treeResponse, root) {
  if (!treeResponse || !Array.isArray(treeResponse.tree)) {
    throw new Error('GitHub did not list that branch.');
  }
  if (treeResponse.truncated) {
    throw new Error('That repository listing was cut off, so nothing was downloaded.');
  }
  const folder = cleanRoot(root);
  const notes = [];
  for (const item of treeResponse.tree) {
    if (!item || item.type !== 'blob' || typeof item.path !== 'string' || typeof item.sha !== 'string') continue;
    if (!item.path.toLowerCase().endsWith('.md')) continue;
    let local = item.path;
    if (folder) {
      if (item.path === folder) continue;
      const prefix = `${folder}/`;
      if (!item.path.startsWith(prefix)) continue;
      local = item.path.slice(prefix.length);
    }
    if (!local || local.endsWith('/')) continue;
    notes.push({ localPath: local, repoPath: item.path, sha: item.sha });
  }
  notes.sort((a, b) => a.localPath.localeCompare(b.localPath));
  return notes;
}

export function planDownload(localFiles, remoteNotes, mode) {
  const locals = localFiles || [];
  if (mode === 'alongside') {
    const writes = [];
    const skipped = [];
    for (const note of remoteNotes) {
      const existing = locals.find((file) => file.path === note.localPath);
      if (existing) skipped.push(note.localPath);
      else writes.push(note);
    }
    return { writes, skipped, remove: [] };
  }
  if (mode === 'replace') {
    return {
      writes: [...remoteNotes],
      skipped: [],
      remove: locals.map((file) => file.path),
    };
  }
  throw new Error('Choose how to keep the notes already on this device.');
}

export function fileFromRemote(note, content, sha, now = Date.now()) {
  return {
    path: note.localPath,
    content,
    kind: 'markdown',
    encoding: 'utf-8',
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    remoteSha: sha,
    dirty: false,
  };
}

export function pushRequest(file, branch) {
  if (!file || file.trashedAt) throw new Error('That note is not available to push.');
  const body = {
    message: `Update ${file.path} from Core Sample`,
    content: encodeUtf8Base64(file.content),
    branch: cleanBranch(branch),
  };
  if (file.remoteSha) body.sha = file.remoteSha;
  return body;
}

export function applyPushResult(file, result) {
  if (!result || result.ok !== true || typeof result.sha !== 'string' || !result.sha) {
    let message = 'The note was not pushed. The copy on this device was kept.';
    if (result && result.status === 409) {
      message = 'GitHub has a different copy of this note. The copy on this device was kept.';
    } else if (result && result.status === 422) {
      message = 'GitHub already has this path. The copy on this device was kept.';
    } else if (result && typeof result.message === 'string' && result.message && !result.message.startsWith('GitHub returned')) {
      message = `${result.message} The copy on this device was kept.`;
    }
    return { file, changed: false, message };
  }
  return {
    file: { ...file, remoteSha: result.sha, dirty: false },
    changed: true,
    message: 'Pushed this note.',
  };
}

export function applyPull(local, remote) {
  if (!remote || typeof remote.content !== 'string' || typeof remote.sha !== 'string' || !remote.sha) {
    return { action: 'keep', file: local, message: 'GitHub did not return that note. The copy on this device was kept.' };
  }
  if (!local) {
    return {
      action: 'create',
      file: fileFromRemote({ localPath: remote.path }, remote.content, remote.sha),
      message: 'Downloaded this note.',
    };
  }
  if (local.content === remote.content) {
    return {
      action: 'adopt',
      file: { ...local, remoteSha: remote.sha, dirty: false },
      message: 'This note already matches GitHub.',
    };
  }
  if (local.dirty || !local.remoteSha) {
    return {
      action: 'keep',
      file: local,
      message: 'This note has local changes. It was not replaced.',
    };
  }
  return {
    action: 'update',
    file: { ...local, content: remote.content, remoteSha: remote.sha, dirty: false, updatedAt: Date.now() },
    message: 'Pulled this note.',
  };
}

export function readErrorMessage(status, bodyText, secrets) {
  let message = `GitHub returned ${status}.`;
  try {
    const body = JSON.parse(bodyText);
    if (body && typeof body.message === 'string' && body.message) message = body.message;
  } catch {
    // The status is enough. Do not surface a raw body.
  }
  return redact(message, secrets);
}

export function folderList(paths) {
  const folders = new Set();
  for (const path of paths || []) {
    const parts = String(path).split('/').slice(0, -1);
    let acc = '';
    for (const part of parts) {
      if (!part || part === '.' || part === '..') continue;
      acc = acc ? `${acc}/${part}` : part;
      folders.add(acc);
    }
  }
  return [...folders].sort();
}

export function readRemoteContent(body, localPath) {
  const label = typeof localPath === 'string' && localPath ? localPath : 'that note';
  if (Array.isArray(body) || !body || typeof body.sha !== 'string' || !body.sha || body.encoding !== 'base64' || typeof body.content !== 'string') {
    throw new Error(`GitHub left out the text of ${label}. Nothing was changed.`);
  }
  try {
    return { path: label, content: decodeUtf8Base64(body.content), sha: body.sha };
  } catch {
    throw new Error(`GitHub left out the text of ${label}. Nothing was changed.`);
  }
}

export async function githubRequest(fetchImpl, url, { token, method = 'GET', body, secrets = [] } = {}) {
  if (token && String(url).includes(token)) throw new Error('The request was refused.');
  const headers = githubHeaders(token);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new Error('GitHub could not be reached. The copy on this device was kept.');
  }
  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  return {
    ok: response.ok,
    status: response.status,
    body: parseJson(text),
    message: readErrorMessage(response.status, text, [token, ...secrets]),
  };
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function relayPost(fetchImpl, relayUrl, which, payload, secrets = []) {
  const url = relayEndpoint(relayUrl, which);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
  } catch {
    throw new Error('The sign-in request failed.');
  }
  let text = '';
  try {
    text = await response.text();
  } catch {
    throw new Error('The sign-in request failed.');
  }
  const body = parseJson(text);
  if (!response.ok && !(body && typeof body.error === 'string')) {
    throw new Error(readErrorMessage(response.status, text, secrets));
  }
  if (!body || typeof body !== 'object') throw new Error('The sign-in request failed.');
  return body;
}

export async function lookupRepository(fetchImpl, { repo, token }) {
  const result = await githubRequest(fetchImpl, repoUrl(repo), { token, secrets: [token] });
  if (!result.ok) throw new Error(result.message);
  const branch = result.body && result.body.default_branch;
  if (typeof branch !== 'string') throw new Error('GitHub did not name a branch.');
  return { defaultBranch: cleanBranch(branch) };
}

export async function lookupLogin(fetchImpl, token) {
  try {
    const result = await githubRequest(fetchImpl, 'https://api.github.com/user', { token, secrets: [token] });
    if (!result.ok) return '';
    const login = result.body && result.body.login;
    return typeof login === 'string' && /^[A-Za-z0-9-]+$/.test(login) ? login : '';
  } catch {
    return '';
  }
}

export async function pushFile(fetchImpl, { file, repo, branch, root, token }) {
  const path = repoPath(root, file.path);
  const url = contentsUrl(repo, path, branch);
  const result = await githubRequest(fetchImpl, url, {
    token,
    method: 'PUT',
    body: pushRequest(file, branch),
    secrets: [token],
  });
  if (!result.ok) return applyPushResult(file, { ok: false, status: result.status, message: result.message });
  const sha = result.body && result.body.content && result.body.content.sha;
  if (typeof sha !== 'string' || !sha) return applyPushResult(file, { ok: false, status: result.status });
  return applyPushResult(file, { ok: true, sha });
}

export async function pullFile(fetchImpl, { file, repo, branch, root, token }) {
  const path = repoPath(root, file.path);
  const url = contentsUrl(repo, path, branch);
  const result = await githubRequest(fetchImpl, url, { token, secrets: [token] });
  if (!result.ok) {
    const message = result.status === 404
      ? 'GitHub did not return that note. The copy on this device was kept.'
      : `${result.message} The copy on this device was kept.`;
    return { action: 'keep', file, message: redact(message, [token]) };
  }
  try {
    return applyPull(file, readRemoteContent(result.body, file.path));
  } catch (error) {
    return {
      action: 'keep',
      file,
      message: redact(error && error.message ? error.message : 'GitHub left out the text of that note. Nothing was changed.', [token]),
    };
  }
}

export async function collectDownload(fetchImpl, { repo, branch, root, token }, onProgress) {
  const listed = await githubRequest(fetchImpl, treeUrl(repo, branch), { token, secrets: [token] });
  if (!listed.ok) throw new Error(listed.message);
  const notes = selectMarkdown(listed.body, root);
  const loaded = [];
  for (let index = 0; index < notes.length; index += 1) {
    if (onProgress) onProgress(index + 1, notes.length);
    const note = notes[index];
    const result = await githubRequest(fetchImpl, contentsUrl(repo, note.repoPath, branch), { token, secrets: [token] });
    if (!result.ok) throw new Error(result.message);
    const remote = readRemoteContent(result.body, note.localPath);
    loaded.push({
      localPath: note.localPath,
      repoPath: note.repoPath,
      sha: remote.sha,
      content: remote.content,
    });
  }
  return loaded;
}

// A strict stand-in for GitHub's Git Data API with a real commit graph:
// per-commit trees, content-addressed blobs, base_tree writes, merge commits,
// and ref updates that only fast-forward. Unknown paths 404. Shared by the
// node tests and the WebKit route mock so both exercise the same history.
import { createHash } from 'node:crypto';

const DATE = '2026-10-21T12:00:00.000Z';

function hash(prefix, value) {
  return `${prefix}${createHash('sha1').update(value).digest('hex').slice(0, 16)}`;
}

function toBytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
}

export function createFakeGit({ token = '', repo = 'owner/repo', branch = 'main', files = {}, dates = {} } = {}) {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const missingBlobs = new Set();
  const log = [];
  const hooks = { beforePatch: null };
  let counter = 0;

  function putBlob(value) {
    const bytes = toBytes(value);
    const sha = hash('b', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
    blobs.set(sha, bytes);
    return sha;
  }

  function putTree(entries) {
    const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b));
    const sha = hash('t', JSON.stringify(sorted));
    trees.set(sha, new Map(sorted));
    return sha;
  }

  function treeFrom(content) {
    const entries = new Map();
    for (const [path, value] of Object.entries(content)) {
      if (value == null) continue;
      entries.set(path, { sha: putBlob(value), mode: '100644' });
    }
    return putTree(entries);
  }

  function makeCommit(tree, parents, message, date = DATE) {
    counter += 1;
    const sha = hash('c', `${counter}:${tree}:${parents.join(',')}:${message}`);
    commits.set(sha, { tree, parents: [...parents], message, date });
    return sha;
  }

  const state = {
    head: '',
    blobs,
    trees,
    commits,
    missingBlobs,
    log,
    hooks,
    patches: 0,
    rejectedPatches: 0,
  };
  state.head = makeCommit(treeFrom(files), [], 'initial', dates.initial || DATE);

  function entriesAt(sha = state.head) {
    const commit = commits.get(sha);
    return new Map(trees.get(commit.tree));
  }

  // Path to text for every file at a commit.
  function snapshot(sha = state.head) {
    const out = new Map();
    for (const [path, entry] of entriesAt(sha)) out.set(path, blobs.get(entry.sha).toString('utf8'));
    return out;
  }

  function blobShaAt(path, sha = state.head) {
    const entry = entriesAt(sha).get(path);
    return entry ? entry.sha : '';
  }

  function bytesAt(path, sha = state.head) {
    const blobSha = blobShaAt(path, sha);
    if (!blobSha || missingBlobs.has(blobSha)) return null;
    const bytes = blobs.get(blobSha);
    return bytes ? Buffer.from(bytes) : null;
  }

  function textAt(path, sha = state.head) {
    const bytes = bytesAt(path, sha);
    return bytes ? bytes.toString('utf8') : '';
  }

  function hideBlob(sha) {
    if (sha) missingBlobs.add(sha);
    return sha;
  }

  // A commit on `parent` that applies `changes` (path to text, or null to delete).
  function commitOn(parent, changes, message = 'vault backup') {
    const entries = entriesAt(parent);
    for (const [path, value] of Object.entries(changes)) {
      if (value == null) entries.delete(path);
      else entries.set(path, { sha: putBlob(value), mode: '100644' });
    }
    return makeCommit(putTree(entries), [parent], message);
  }

  // A merge commit whose tree is exactly `content` (path to text).
  function mergeCommit(parents, content, message = 'vault backup') {
    const entries = new Map();
    for (const [path, value] of Object.entries(content)) {
      entries.set(path, { sha: putBlob(value), mode: '100644' });
    }
    return makeCommit(putTree(entries), parents, message);
  }

  // Three-way merge by whole file, as Obsidian Git's `git pull` would do when
  // the two sides touched different files. Throws on a same-file clash.
  function mergeFiles(ours, theirs, message = 'Merge branch main') {
    const base = mergeBase(ours, theirs);
    const b = base ? entriesAt(base) : new Map();
    const o = entriesAt(ours);
    const t = entriesAt(theirs);
    const key = (entry) => (entry ? `${entry.mode}:${entry.sha}` : '');
    const result = new Map();
    for (const path of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
      const [bv, ov, tv] = [b.get(path), o.get(path), t.get(path)];
      let value;
      if (key(ov) === key(tv)) value = ov;
      else if (key(ov) === key(bv)) value = tv;
      else if (key(tv) === key(bv)) value = ov;
      else throw new Error(`fake merge clash on ${path}`);
      if (value) result.set(path, value);
    }
    return makeCommit(putTree(result), [ours, theirs], message);
  }

  function ancestors(sha) {
    const seen = new Set();
    const queue = [sha];
    while (queue.length) {
      const next = queue.shift();
      if (!next || seen.has(next)) continue;
      seen.add(next);
      queue.push(...(commits.get(next)?.parents || []));
    }
    return seen;
  }

  function mergeBase(a, b) {
    const left = ancestors(a);
    const queue = [b];
    const seen = new Set();
    while (queue.length) {
      const next = queue.shift();
      if (seen.has(next)) continue;
      seen.add(next);
      if (left.has(next)) return next;
      queue.push(...(commits.get(next)?.parents || []));
    }
    return '';
  }

  function descends(sha, ancestor) {
    return ancestors(sha).has(ancestor);
  }

  function reply(status, body, headers = {}) {
    return { status, body: status === 304 ? null : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } };
  }

  function replyRaw(status, bytes, headers = {}) {
    return {
      status,
      body: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []),
      headers: { 'content-type': 'application/octet-stream', ...headers },
    };
  }

  function resolveTreeSha(name) {
    if (trees.has(name)) return name;
    if (name === branch) {
      const commit = commits.get(state.head);
      return commit ? commit.tree : '';
    }
    const commit = commits.get(name);
    return commit ? commit.tree : '';
  }

  function acceptRaw(headers) {
    const accept = String(headers.Accept || headers.accept || '');
    return accept.includes('application/vnd.github.raw');
  }

  async function handle({ method = 'GET', url, headers = {}, body = null }) {
    const text = String(url);
    if (token && text.includes(token)) throw new Error('token leaked into the url');
    const parsed = new URL(text);
    const path = decodeURIComponent(parsed.pathname);
    const auth = headers.Authorization || headers.authorization || '';
    const json = body ? (typeof body === 'string' ? JSON.parse(body) : body) : null;
    log.push({ method, path, url: text, body: json, auth });
    if (token && auth !== `Bearer ${token}`) return reply(401, { message: 'Bad credentials' });
    const base = `/repos/${repo}`;
    if (path === '/user' && method === 'GET') return reply(200, { login: 'octocat' });
    if (path === base && method === 'GET') {
      const [owner, name] = repo.split('/');
      return reply(200, {
        name,
        full_name: repo,
        private: true,
        default_branch: branch,
        owner: { login: owner },
      });
    }
    if (path === `${base}/git/ref/heads/${branch}` && method === 'GET') {
      const etag = `"${state.head}"`;
      const match = headers['If-None-Match'] || headers['if-none-match'];
      if (match && match === etag) return reply(304, null, { etag });
      return reply(200, { ref: `refs/heads/${branch}`, object: { sha: state.head, type: 'commit' } }, { etag });
    }
    let match = path.match(new RegExp(`^${base}/git/commits/([^/]+)$`));
    if (match && method === 'GET') {
      if (state.failCommitReads && match[1] !== state.head) return reply(502, { message: 'Bad gateway' });
      const commit = commits.get(match[1]);
      if (!commit) return reply(404, { message: 'Not Found' });
      return reply(200, {
        sha: match[1],
        tree: { sha: commit.tree },
        parents: commit.parents.map((sha) => ({ sha })),
        message: commit.message,
        committer: { date: commit.date },
      });
    }
    match = path.match(new RegExp(`^${base}/git/trees/([^/]+)$`));
    if (match && method === 'GET') {
      const tree = trees.get(resolveTreeSha(match[1]));
      if (!tree) return reply(404, { message: 'Not Found' });
      const listed = [];
      const dirs = new Set();
      for (const [entryPath, entry] of tree) {
        const parts = entryPath.split('/');
        for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
        listed.push({ path: entryPath, mode: entry.mode, type: 'blob', sha: entry.sha, size: blobs.get(entry.sha).length });
      }
      for (const dir of dirs) listed.push({ path: dir, mode: '040000', type: 'tree', sha: hash('t', dir) });
      listed.sort((a, b) => a.path.localeCompare(b.path));
      return reply(200, { sha: match[1], truncated: false, tree: listed });
    }
    match = path.match(new RegExp(`^${base}/git/blobs/([^/]+)$`));
    if (match && method === 'GET') {
      if (missingBlobs.has(match[1])) return reply(404, { message: 'Not Found' });
      const bytes = blobs.get(match[1]);
      if (!bytes) return reply(404, { message: 'Not Found' });
      return reply(200, { sha: match[1], encoding: 'base64', content: bytes.toString('base64'), size: bytes.length });
    }
    const contentsPrefix = `${base}/contents/`;
    if (path.startsWith(contentsPrefix)) {
      const filePath = path.slice(contentsPrefix.length);
      const ref = parsed.searchParams.get('ref') || branch;
      const at = commits.has(ref) ? ref : state.head;
      if (method === 'GET') {
        const entry = entriesAt(at).get(filePath);
        if (!entry) return reply(404, { message: 'Not Found' });
        if (missingBlobs.has(entry.sha)) return reply(404, { message: 'Not Found' });
        const bytes = blobs.get(entry.sha);
        if (!bytes) return reply(404, { message: 'Not Found' });
        if (acceptRaw(headers)) return replyRaw(200, bytes);
        return reply(200, {
          name: filePath.split('/').pop(),
          path: filePath,
          sha: entry.sha,
          size: bytes.length,
          type: 'file',
          encoding: 'base64',
          content: bytes.toString('base64'),
        });
      }
      if (method === 'PUT') {
        const current = entriesAt(state.head).get(filePath);
        if (json?.sha) {
          if (!current || current.sha !== json.sha) return reply(409, { message: 'sha mismatch' });
        } else if (current) {
          return reply(422, { message: 'sha was expected' });
        }
        const bytes = json?.encoding === 'utf-8'
          ? Buffer.from(String(json.content ?? ''), 'utf8')
          : Buffer.from(String(json?.content ?? ''), 'base64');
        const blobSha = putBlob(bytes);
        const commitSha = commitOn(state.head, { [filePath]: bytes }, json?.message || 'Update');
        state.head = commitSha;
        return reply(200, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, type: 'file' },
          commit: { sha: commitSha },
        });
      }
    }
    if (path === `${base}/git/blobs` && method === 'POST') {
      const content = json.encoding === 'base64' ? Buffer.from(json.content, 'base64') : json.content;
      return reply(201, { sha: putBlob(content) });
    }
    if (path === `${base}/git/trees` && method === 'POST') {
      if (!json.base_tree || !trees.has(json.base_tree)) return reply(422, { message: 'base_tree is required here' });
      const entries = new Map(trees.get(json.base_tree));
      for (const entry of json.tree || []) {
        if (entry.sha == null) entries.delete(entry.path);
        else {
          if (!blobs.has(entry.sha)) return reply(422, { message: 'Invalid tree info' });
          entries.set(entry.path, { sha: entry.sha, mode: entry.mode || '100644' });
        }
      }
      return reply(201, { sha: putTree(entries) });
    }
    if (path === `${base}/git/commits` && method === 'POST') {
      if (!trees.has(json.tree) || !(json.parents || []).every((sha) => commits.has(sha))) {
        return reply(422, { message: 'Invalid commit' });
      }
      const sha = makeCommit(json.tree, json.parents || [], json.message || '');
      return reply(201, { sha, tree: { sha: json.tree }, committer: { date: DATE } });
    }
    if (path === `${base}/git/refs/heads/${branch}` && method === 'PATCH') {
      if (json.force !== false) return reply(422, { message: 'force is not allowed' });
      if (hooks.beforePatch) await hooks.beforePatch(state);
      state.patches += 1;
      if (!commits.has(json.sha) || !descends(json.sha, state.head)) {
        state.rejectedPatches += 1;
        return reply(422, { message: 'Update is not a fast forward' });
      }
      state.head = json.sha;
      return reply(200, { ref: `refs/heads/${branch}`, object: { sha: json.sha, type: 'commit' } });
    }
    return reply(404, { message: 'Not Found' });
  }

  async function fetchImpl(url, options = {}) {
    const result = await handle({ method: options.method || 'GET', url, headers: options.headers || {}, body: options.body || null });
    return new Response(result.body, { status: result.status, headers: result.headers });
  }

  return {
    state,
    handle,
    fetchImpl,
    putBlob,
    snapshot,
    blobShaAt,
    bytesAt,
    textAt,
    hideBlob,
    entriesAt,
    commitOn,
    mergeCommit,
    mergeFiles,
    descends,
    // Moves the branch as another client's push would.
    advance(sha) {
      state.head = sha;
      return sha;
    },
  };
}

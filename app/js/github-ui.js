import { redact } from './github-redact.js';
import { signInWithDevice } from './github-device.js';
import {
  cleanBranch,
  cleanClientId,
  cleanRelayUrl,
  cleanRepo,
  cleanRoot,
  collectDownload,
  lookupLogin,
  lookupRepository,
  pullFile,
  pushFile,
  relayPost,
} from './github-api.js';
import {
  disconnectGithub,
  loadGithubSettings,
  saveGithubConfig,
  saveGithubSession,
  saveGithubTarget,
} from './github-store.js';

export function mountGithub(doc, db, hooks) {
  const sheet = doc.getElementById('github-sheet');
  if (!sheet) return { async refresh() {} };

  const clientInput = doc.getElementById('github-client-id');
  const relayInput = doc.getElementById('github-relay');
  const repoInput = doc.getElementById('github-repo');
  const branchInput = doc.getElementById('github-branch');
  const rootInput = doc.getElementById('github-root');
  const status = doc.getElementById('github-status');
  const deviceBlock = doc.getElementById('github-device');
  const codeButton = doc.getElementById('github-user-code');
  const verifyLink = doc.getElementById('github-verify');
  const target = doc.getElementById('github-target');
  const loginText = doc.getElementById('github-login');
  const choice = doc.getElementById('github-choice');
  const confirmReplace = doc.getElementById('github-confirm-replace');
  const disconnectConfirm = doc.getElementById('github-disconnect-confirm');
  const eraseConfirm = doc.getElementById('github-erase-confirm');
  const connectButton = doc.getElementById('github-connect');
  const fileBar = doc.getElementById('github-file-bar');
  const fileStatus = doc.getElementById('github-file-status');
  const view = doc.defaultView || globalThis;
  const fetchImpl = view.fetch.bind(view);

  let busy = false;
  let stopSignIn = false;
  let pendingDownload = null;
  let exportedForReplace = false;

  function setStatus(text) {
    status.textContent = text || '';
  }

  function showError(error, settings) {
    const secrets = settings && settings.token ? [settings.token] : [];
    setStatus(redact(error && error.message ? error.message : 'Something went wrong.', secrets));
  }

  function hideChoices() {
    choice.hidden = true;
    confirmReplace.hidden = true;
    disconnectConfirm.hidden = true;
    eraseConfirm.hidden = true;
    pendingDownload = null;
    exportedForReplace = false;
  }

  async function refresh() {
    const settings = await loadGithubSettings(db);
    clientInput.value = settings.clientId;
    relayInput.value = settings.relay;
    repoInput.value = settings.repo;
    branchInput.value = settings.branch;
    rootInput.value = settings.root;
    const signedIn = Boolean(settings.token);
    target.hidden = !signedIn;
    loginText.textContent = settings.login ? `Signed in as ${settings.login}` : (signedIn ? 'Signed in.' : '');
    connectButton.hidden = signedIn;
    const ready = signedIn && Boolean(settings.repo) && Boolean(settings.branch);
    if (fileBar) fileBar.hidden = !ready;
    if (!ready && fileStatus) fileStatus.textContent = '';
    return settings;
  }

  async function saveConfig() {
    const clientId = cleanClientId(clientInput.value);
    const relay = cleanRelayUrl(relayInput.value);
    await saveGithubConfig(db, { clientId, relay });
    clientInput.value = clientId;
    relayInput.value = relay;
    setStatus('Saved the client id and relay.');
  }

  async function connect() {
    if (busy) return;
    busy = true;
    stopSignIn = false;
    hideChoices();
    try {
      const clientId = cleanClientId(clientInput.value);
      const relay = cleanRelayUrl(relayInput.value);
      if (!clientId) throw new Error('Add the client id first.');
      if (!relay) throw new Error('Add the relay URL first.');
      await saveGithubConfig(db, { clientId, relay });
      setStatus('Waiting for GitHub…');
      const result = await signInWithDevice({
        clientId,
        sleep: (ms) => new Promise((resolve) => { view.setTimeout(resolve, ms); }),
        shouldStop: () => stopSignIn,
        onCode: ({ userCode, verification }) => {
          codeButton.textContent = userCode;
          verifyLink.href = verification;
          deviceBlock.hidden = false;
          setStatus('Enter this code on GitHub.');
        },
        postJson: (which, payload) => relayPost(fetchImpl, relay, which, payload, [clientId]),
      });
      deviceBlock.hidden = true;
      codeButton.textContent = '';
      if (result.cancelled) {
        setStatus('Sign-in was cancelled.');
        return;
      }
      if (!result.token) {
        setStatus(result.failure || 'GitHub did not sign in.');
        return;
      }
      await saveGithubSession(db, { token: result.token, login: '' });
      const login = await lookupLogin(fetchImpl, result.token);
      if (login) await saveGithubSession(db, { token: result.token, login });
      await refresh();
      setStatus(login ? `Signed in as ${login}.` : 'Signed in.');
    } catch (error) {
      deviceBlock.hidden = true;
      codeButton.textContent = '';
      showError(error);
    } finally {
      busy = false;
    }
  }

  async function saveRepo() {
    if (busy) return;
    busy = true;
    hideChoices();
    const settings = await loadGithubSettings(db);
    try {
      if (!settings.token) throw new Error('Connect GitHub first.');
      const repo = cleanRepo(repoInput.value);
      const root = cleanRoot(rootInput.value);
      let branch = branchInput.value.trim();
      if (!branch) {
        const found = await lookupRepository(fetchImpl, { repo, token: settings.token });
        branch = found.defaultBranch;
        branchInput.value = branch;
      } else {
        branch = cleanBranch(branch);
      }
      await saveGithubTarget(db, { repo, branch, root });
      await refresh();
      setStatus('Saved the repository.');
    } catch (error) {
      showError(error, settings);
    } finally {
      busy = false;
    }
  }

  function savedTargetMatches(settings) {
    return cleanRepo(repoInput.value) === settings.repo
      && cleanBranch(branchInput.value) === settings.branch
      && cleanRoot(rootInput.value) === settings.root;
  }

  async function download() {
    if (busy) return;
    busy = true;
    hideChoices();
    const settings = await loadGithubSettings(db);
    try {
      if (!settings.token || !settings.repo || !settings.branch) throw new Error('Save the repo first.');
      if (!savedTargetMatches(settings)) throw new Error('Save the repo first.');
      const loaded = await collectDownload(fetchImpl, settings, (done, total) => {
        setStatus(`Downloading ${done} of ${total}`);
      });
      if (!loaded.length) {
        setStatus('No Markdown files were found. Nothing on this phone was changed.');
        return;
      }
      const local = hooks.files();
      if (local.length) {
        pendingDownload = loaded;
        choice.hidden = false;
        setStatus('This phone already has notes. Choose what to do.');
        return;
      }
      hooks.hold(true);
      try {
        const counts = await hooks.applyDownload(loaded, 'alongside');
        setStatus(downloadMessage(counts));
      } finally {
        hooks.hold(false);
      }
    } catch (error) {
      showError(error, settings);
    } finally {
      busy = false;
    }
  }

  async function keepAlongside() {
    if (busy || !pendingDownload) return;
    busy = true;
    const loaded = pendingDownload;
    const settings = await loadGithubSettings(db);
    hooks.hold(true);
    try {
      const counts = await hooks.applyDownload(loaded, 'alongside');
      hideChoices();
      setStatus(downloadMessage(counts));
    } catch (error) {
      showError(error, settings);
    } finally {
      hooks.hold(false);
      busy = false;
    }
  }

  async function exportThenReplace() {
    if (busy || !pendingDownload) return;
    const exported = await hooks.exportBackup();
    if (!exported) {
      setStatus('Export the backup before replacing.');
      return;
    }
    exportedForReplace = true;
    confirmReplace.hidden = false;
    setStatus('Backup exported. Confirm to replace the notes on this phone.');
  }

  async function replaceConfirmed() {
    if (busy || !pendingDownload || !exportedForReplace) return;
    busy = true;
    const loaded = pendingDownload;
    const settings = await loadGithubSettings(db);
    hooks.hold(true);
    try {
      const counts = await hooks.applyDownload(loaded, 'replace');
      hideChoices();
      setStatus(counts.downloaded
        ? `Replaced the notes on this phone with ${counts.downloaded} from GitHub.`
        : 'No Markdown files were found. Nothing on this phone was changed.');
    } catch (error) {
      showError(error, settings);
    } finally {
      hooks.hold(false);
      busy = false;
    }
  }

  async function disconnect() {
    if (busy) return;
    busy = true;
    stopSignIn = true;
    try {
      await disconnectGithub(db);
      hideChoices();
      deviceBlock.hidden = true;
      codeButton.textContent = '';
      await refresh();
      setStatus('Disconnected. Notes on this phone were kept.');
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  async function erase() {
    if (busy) return;
    busy = true;
    try {
      await hooks.eraseLocal();
      hideChoices();
      setStatus('Erased the notes on this phone. GitHub was not changed.');
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  async function pushCurrent() {
    if (busy) return;
    const settings = await loadGithubSettings(db);
    const file = hooks.current();
    if (!file) {
      fileStatus.textContent = 'Open a note first.';
      return;
    }
    busy = true;
    hooks.hold(true);
    try {
      if (!(await hooks.flush())) {
        fileStatus.textContent = "Couldn't save this note. It was not pushed.";
        return;
      }
      const before = hooks.current();
      const outcome = await pushFile(fetchImpl, {
        file: before,
        repo: settings.repo,
        branch: settings.branch,
        root: settings.root,
        token: settings.token,
      });
      if (outcome.changed) {
        const latest = hooks.current();
        const typedDuring = latest && latest.content !== before.content;
        await hooks.replaceFile(typedDuring
          ? { ...outcome.file, content: latest.content, dirty: true, updatedAt: Date.now() }
          : outcome.file);
      }
      fileStatus.textContent = outcome.message;
    } catch (error) {
      fileStatus.textContent = redact(error && error.message ? error.message : 'The note was not pushed. The copy on this device was kept.', [settings.token]);
    } finally {
      hooks.hold(false);
      busy = false;
    }
  }

  async function pullCurrent() {
    if (busy) return;
    const settings = await loadGithubSettings(db);
    const file = hooks.current();
    if (!file) {
      fileStatus.textContent = 'Open a note first.';
      return;
    }
    busy = true;
    hooks.hold(true);
    try {
      if (!(await hooks.flush())) {
        fileStatus.textContent = "Couldn't save this note. It was not pulled.";
        return;
      }
      const before = hooks.current();
      const outcome = await pullFile(fetchImpl, {
        file: before,
        repo: settings.repo,
        branch: settings.branch,
        root: settings.root,
        token: settings.token,
      });
      const latest = hooks.current();
      const typedDuring = latest && latest.content !== before.content && latest.content !== outcome.file.content;
      if (outcome.action !== 'keep' && !typedDuring) await hooks.replaceFile(outcome.file);
      fileStatus.textContent = typedDuring
        ? 'This note has local changes. It was not replaced.'
        : outcome.message;
    } catch (error) {
      fileStatus.textContent = redact(error && error.message ? error.message : 'The copy on this device was kept.', [settings.token]);
    } finally {
      hooks.hold(false);
      busy = false;
    }
  }

  doc.getElementById('github-button').addEventListener('click', () => {
    refresh().then(() => {
      sheet.hidden = false;
    }).catch((error) => showError(error));
  });
  doc.getElementById('github-close').addEventListener('click', () => {
    sheet.hidden = true;
  });
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet) sheet.hidden = true;
  });
  doc.getElementById('github-save-config').addEventListener('click', () => {
    saveConfig().catch((error) => showError(error));
  });
  connectButton.addEventListener('click', () => {
    connect();
  });
  codeButton.addEventListener('click', async () => {
    const code = codeButton.textContent;
    if (!code) return;
    try {
      await view.navigator.clipboard.writeText(code);
      setStatus('Copied the code.');
    } catch {
      setStatus('Copy the code shown above.');
    }
  });
  doc.getElementById('github-cancel').addEventListener('click', () => {
    stopSignIn = true;
    deviceBlock.hidden = true;
    codeButton.textContent = '';
    setStatus('Sign-in was cancelled.');
  });
  doc.getElementById('github-save-repo').addEventListener('click', () => {
    saveRepo();
  });
  doc.getElementById('github-download').addEventListener('click', () => {
    download();
  });
  doc.getElementById('github-alongside').addEventListener('click', () => {
    keepAlongside();
  });
  doc.getElementById('github-export-replace').addEventListener('click', () => {
    exportThenReplace();
  });
  confirmReplace.addEventListener('click', () => {
    replaceConfirmed();
  });
  doc.getElementById('github-disconnect').addEventListener('click', () => {
    disconnectConfirm.hidden = false;
  });
  doc.getElementById('github-disconnect-yes').addEventListener('click', () => {
    disconnect();
  });
  doc.getElementById('github-erase').addEventListener('click', () => {
    eraseConfirm.hidden = false;
  });
  doc.getElementById('github-erase-yes').addEventListener('click', () => {
    erase();
  });
  const pushButton = doc.getElementById('github-push');
  const pullButton = doc.getElementById('github-pull');
  if (pushButton) pushButton.addEventListener('click', () => { pushCurrent(); });
  if (pullButton) pullButton.addEventListener('click', () => { pullCurrent(); });

  return { refresh };
}

function downloadMessage(counts) {
  if (counts.empty) return 'No Markdown files were found. Nothing on this phone was changed.';
  if (!counts.downloaded) return 'Those notes are already on this phone. Nothing was replaced.';
  if (counts.skipped) return `Downloaded ${counts.downloaded}. Kept ${counts.skipped} already on this phone.`;
  return `Downloaded ${counts.downloaded}.`;
}

import { redact } from './github-redact.js';
import {
  DEVICE_PAGE,
  createDeviceSignIn,
  deviceCodeRequest,
  pendingFlow,
  readDeviceStart,
  tokenPollRequest,
} from './github-device.js';
import {
  ACCESS_CHECK_MS,
  cleanBranch,
  cleanClientId,
  cleanRelayUrl,
  cleanRepo,
  cleanRoot,
  collectDownload,
  describeAccess,
  lookupLogin,
  lookupRepository,
  pullFile,
  pushFile,
  relayPost,
} from './github-api.js';
import {
  clearPendingFlow,
  disconnectGithub,
  loadGithubSettings,
  loadPendingFlow,
  loadStorageFlag,
  saveGithubConfig,
  saveGithubSession,
  saveGithubTarget,
  savePendingFlow,
  storagePersistenceText,
} from './github-store.js';

const ACCESS_TTL = 10 * 60 * 1000;

export function mountGithub(doc, db, hooks) {
  const sheet = doc.getElementById('github-sheet');
  if (!sheet) return { async refresh() {}, resume() {} };

  const clientInput = doc.getElementById('github-client-id');
  const relayInput = doc.getElementById('github-relay');
  const repoInput = doc.getElementById('github-repo');
  const branchInput = doc.getElementById('github-branch');
  const rootInput = doc.getElementById('github-root');
  const status = doc.getElementById('github-status');
  const deviceBlock = doc.getElementById('github-device');
  const signInState = doc.getElementById('github-signin-state');
  const codeButton = doc.getElementById('github-user-code');
  const verifyLink = doc.getElementById('github-verify');
  const tryAgain = doc.getElementById('github-try-again');
  const target = doc.getElementById('github-target');
  const loginText = doc.getElementById('github-login');
  const choice = doc.getElementById('github-choice');
  const confirmReplace = doc.getElementById('github-confirm-replace');
  const disconnectConfirm = doc.getElementById('github-disconnect-confirm');
  const eraseConfirm = doc.getElementById('github-erase-confirm');
  const connectButton = doc.getElementById('github-connect');
  const signAgain = doc.getElementById('github-sign-in-again');
  const storageLine = doc.getElementById('github-storage');
  const fileBar = doc.getElementById('github-file-bar');
  const fileStatus = doc.getElementById('github-file-status');
  const view = doc.defaultView || globalThis;
  const fetchImpl = view.fetch.bind(view);
  const now = hooks.now || (() => Date.now());
  const sleep = hooks.sleep || ((ms) => new Promise((resolve) => {
    view.setTimeout(resolve, ms);
  }));

  let busy = false;
  let starting = false;
  let relayUrl = '';
  let clientId = '';
  let pendingDownload = null;
  let exportedForReplace = false;
  let userUnauthorized = false;
  let lastAccess = null;
  let checkedAt = 0;
  let probeFlight = null;
  let probeGen = 0;

  function rememberedConfig() {
    clientId = cleanClientId(clientInput.value);
    relayUrl = cleanRelayUrl(relayInput.value);
    return { clientId, relay: relayUrl };
  }

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

  function signedInLine(settings) {
    if (!settings.token) return '';
    if (settings.login) return `Signed in as ${settings.login}`;
    return 'Signed in.';
  }

  function accessLine(settings) {
    if (!settings.token) return '';
    if (lastAccess && lastAccess.state === 'unauthorized') return 'Sign in again';
    if (!lastAccess || !lastAccess.message) return signedInLine(settings);
    if (lastAccess.message.startsWith('Signed in')) return lastAccess.message;
    return `${signedInLine(settings)}. ${lastAccess.message}`;
  }

  async function paint(settings) {
    clientInput.value = settings.clientId;
    relayInput.value = settings.relay;
    repoInput.value = settings.repo;
    branchInput.value = settings.branch;
    rootInput.value = settings.root;
    const pending = await loadPendingFlow(db);
    const pendingLive = Boolean(pending && now() < pending.expiresAt);
    const signedIn = Boolean(settings.token);
    target.hidden = !signedIn;
    loginText.textContent = accessLine(settings);
    connectButton.hidden = signedIn || pendingLive;
    if (signAgain) signAgain.hidden = !(signedIn && userUnauthorized);
    if (signedIn) tryAgain.hidden = true;
    const ready = signedIn && Boolean(settings.repo) && Boolean(settings.branch);
    if (fileBar) fileBar.hidden = !ready;
    if (!ready && fileStatus) fileStatus.textContent = '';
    if (storageLine) storageLine.textContent = storagePersistenceText(await loadStorageFlag(db));
    return pendingLive;
  }

  function accessDue(at) {
    return checkedAt === 0 || at - checkedAt >= ACCESS_TTL;
  }

  function startProbe(settings) {
    if (!settings.token) return Promise.resolve(null);
    if (!accessDue(now())) return probeFlight || Promise.resolve(lastAccess);
    const gen = ++probeGen;
    checkedAt = now();
    const timeoutMs = hooks.accessTimeoutMs || ACCESS_CHECK_MS;
    const flight = describeAccess(fetchImpl, settings, { timeoutMs }).then(async (access) => {
      if (gen !== probeGen) return access;
      lastAccess = access;
      userUnauthorized = access.state === 'unauthorized';
      if (access.login) {
        const current = await loadGithubSettings(db);
        if (current.token === settings.token && current.login !== access.login) {
          await saveGithubSession(db, { token: current.token, login: access.login });
        }
      }
      const fresh = await loadGithubSettings(db);
      if (fresh.token === settings.token) await paint(fresh);
      return access;
    }).catch(async () => {
      if (gen !== probeGen) return lastAccess;
      lastAccess = { state: 'signed-in', login: '', message: "Couldn't reach GitHub (offline)" };
      userUnauthorized = false;
      const fresh = await loadGithubSettings(db);
      if (fresh.token) await paint(fresh);
      return lastAccess;
    });
    let tracked;
    tracked = flight.finally(() => {
      if (probeFlight === tracked) probeFlight = null;
    });
    probeFlight = tracked;
    return tracked;
  }

  async function refresh() {
    const pending = await loadPendingFlow(db);
    if (pending && !(now() < pending.expiresAt)) await clearPendingFlow(db);
    const settings = await loadGithubSettings(db);
    await paint(settings);
    startProbe(settings);
    return settings;
  }

  function showPending(flow) {
    sheet.hidden = false;
    deviceBlock.hidden = false;
    tryAgain.hidden = true;
    connectButton.hidden = true;
    codeButton.textContent = flow.userCode;
    if (signInState) signInState.textContent = 'Finishing sign-in…';
    verifyLink.href = DEVICE_PAGE;
    verifyLink.target = '_blank';
    verifyLink.rel = 'noopener';
    setStatus('Finishing sign-in…');
  }

  function hidePending() {
    deviceBlock.hidden = true;
    codeButton.textContent = '';
    if (signInState) signInState.textContent = '';
  }

  async function onToken(token) {
    probeGen += 1;
    userUnauthorized = false;
    lastAccess = null;
    checkedAt = now();
    await saveGithubSession(db, { token, login: '' });
    let login = '';
    try {
      login = await lookupLogin(fetchImpl, token);
    } catch {
      login = '';
    }
    if (login) await saveGithubSession(db, { token, login });
    await clearPendingFlow(db);
    hidePending();
    tryAgain.hidden = true;
    await refresh();
    sheet.hidden = false;
    target.hidden = false;
    if (repoInput.scrollIntoView) repoInput.scrollIntoView({ block: 'center' });
    repoInput.focus();
    setStatus(login ? `Signed in as ${login}.` : 'Signed in.');
  }

  async function onFailure(message) {
    hidePending();
    const settings = await loadGithubSettings(db);
    const signedIn = Boolean(settings.token);
    tryAgain.hidden = signedIn;
    connectButton.hidden = signedIn;
    if (signAgain) signAgain.hidden = !(signedIn && userUnauthorized);
    setStatus(message || 'GitHub did not sign in.');
  }

  const signIn = createDeviceSignIn({
    loadPending: () => loadPendingFlow(db),
    savePending: (flow) => savePendingFlow(db, flow),
    clearPending: () => clearPendingFlow(db),
    postToken: async (deviceCode) => {
      const settings = await loadGithubSettings(db);
      const id = settings.clientId || clientId;
      const relay = settings.relay || relayUrl;
      return relayPost(
        fetchImpl,
        relay,
        'token',
        tokenPollRequest(id, deviceCode),
        [id, deviceCode],
      );
    },
    sleep,
    now,
    onPending: showPending,
    onToken,
    onFailure,
  });

  function kick() {
    if (starting) return undefined;
    if (signIn.active) return signIn.checkNow();
    return signIn.resume().catch((error) => showError(error));
  }

  async function saveConfig() {
    const config = rememberedConfig();
    await saveGithubConfig(db, config);
    clientInput.value = config.clientId;
    relayInput.value = config.relay;
    setStatus('Saved the client id and relay.');
  }

  async function connect() {
    if (starting || signIn.active) return;
    starting = true;
    hideChoices();
    tryAgain.hidden = true;
    try {
      const config = rememberedConfig();
      if (!config.clientId) throw new Error('Add the client id first.');
      if (!config.relay) throw new Error('Add the relay URL first.');
      await saveGithubConfig(db, config);
      clientInput.value = config.clientId;
      relayInput.value = config.relay;
      const startBody = await relayPost(
        fetchImpl,
        config.relay,
        'code',
        deviceCodeRequest(config.clientId),
        [config.clientId],
      );
      const start = readDeviceStart(startBody);
      await savePendingFlow(db, pendingFlow(start, now()));
      showPending({ userCode: start.userCode });
      starting = false;
      await signIn.start();
    } catch (error) {
      hidePending();
      const settings = await loadGithubSettings(db);
      const signedIn = Boolean(settings.token);
      tryAgain.hidden = signedIn;
      connectButton.hidden = signedIn;
      if (signAgain) signAgain.hidden = !(signedIn && userUnauthorized);
      showError(error);
    } finally {
      starting = false;
    }
  }

  function copyAndOpen() {
    const code = codeButton.textContent;
    let opened = null;
    try {
      opened = view.open(DEVICE_PAGE, '_blank', 'noopener');
    } catch {
      opened = null;
    }
    const write = view.navigator?.clipboard?.writeText;
    if (code && write) {
      Promise.resolve()
        .then(() => write.call(view.navigator.clipboard, code))
        .then(
          () => setStatus('Copied the code. Approve it on GitHub, then come back to Core Sample.'),
          () => setStatus('Copy the code shown above. Approve it on GitHub, then come back to Core Sample.'),
        );
    } else {
      setStatus('Copy the code shown above. Approve it on GitHub, then come back to Core Sample.');
    }
    if (!opened) verifyLink.click();
  }

  async function cancelSignIn() {
    starting = false;
    await signIn.cancel();
    hidePending();
    tryAgain.hidden = true;
    const settings = await loadGithubSettings(db);
    const signedIn = Boolean(settings.token);
    connectButton.hidden = signedIn;
    if (signAgain) signAgain.hidden = !(signedIn && userUnauthorized);
    setStatus('Sign-in was cancelled.');
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
    try {
      await signIn.cancel();
      await disconnectGithub(db);
      hideChoices();
      hidePending();
      tryAgain.hidden = true;
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
      kick();
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
  if (signAgain) {
    signAgain.addEventListener('click', () => {
      connect();
    });
  }
  const exportBackupButton = doc.getElementById('github-export-backup');
  if (exportBackupButton) {
    exportBackupButton.addEventListener('click', () => {
      if (!hooks.exportBackup) return;
      Promise.resolve(hooks.exportBackup()).catch((error) => showError(error));
    });
  }
  codeButton.addEventListener('click', () => {
    const code = codeButton.textContent;
    if (!code) return;
    const write = view.navigator?.clipboard?.writeText;
    if (!write) {
      setStatus('Copy the code shown above.');
      return;
    }
    Promise.resolve()
      .then(() => write.call(view.navigator.clipboard, code))
      .then(
        () => setStatus('Copied the code.'),
        () => setStatus('Copy the code shown above.'),
      );
  });
  doc.getElementById('github-open-github').addEventListener('click', () => {
    copyAndOpen();
  });
  doc.getElementById('github-check-now').addEventListener('click', () => {
    if (signIn.active) signIn.checkNow();
    else kick();
  });
  doc.getElementById('github-cancel').addEventListener('click', () => {
    cancelSignIn();
  });
  tryAgain.addEventListener('click', () => {
    connect();
  });
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') kick();
  });
  view.addEventListener('pageshow', () => {
    kick();
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

  return {
    refresh,
    resume: kick,
    whenChecked() {
      return probeFlight || Promise.resolve(lastAccess);
    },
  };
}

function downloadMessage(counts) {
  if (counts.empty) return 'No Markdown files were found. Nothing on this phone was changed.';
  if (!counts.downloaded) return 'Those notes are already on this phone. Nothing was replaced.';
  if (counts.skipped) return `Downloaded ${counts.downloaded}. Kept ${counts.skipped} already on this phone.`;
  return `Downloaded ${counts.downloaded}.`;
}

// OAuth Apps cannot ask for file contents alone. `repo` is the smallest
// scope that can read and write a private repository. `public_repo` cannot.
export const GITHUB_SCOPE = 'repo';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export function deviceCodeRequest(clientId) {
  return { client_id: clientId, scope: GITHUB_SCOPE };
}

export function tokenPollRequest(clientId, deviceCode) {
  return {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: DEVICE_GRANT,
  };
}

export function verificationLink(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname === '/login/device') {
      return url.toString();
    }
  } catch {
    // Fall through to the fixed device page.
  }
  return 'https://github.com/login/device';
}

export function readDeviceStart(body) {
  if (!body || typeof body.user_code !== 'string' || typeof body.device_code !== 'string' || !body.user_code || !body.device_code) {
    throw new Error('GitHub did not return a device code.');
  }
  return {
    userCode: body.user_code,
    deviceCode: body.device_code,
    interval: Number(body.interval) > 0 ? Number(body.interval) : 5,
    expiresIn: Number(body.expires_in) > 0 ? Number(body.expires_in) : 900,
    verification: verificationLink(body.verification_uri),
  };
}

// GitHub: wait `interval` seconds. On slow_down, add 5 seconds and keep using that.
export function interpretPoll(body, intervalSeconds) {
  const interval = Number(intervalSeconds) > 0 ? Number(intervalSeconds) : 5;
  if (body && typeof body.access_token === 'string' && body.access_token) {
    return { done: true, token: body.access_token };
  }
  const error = body && typeof body.error === 'string' ? body.error : '';
  if (error === 'authorization_pending') return { done: false, wait: interval };
  if (error === 'slow_down') return { done: false, wait: interval + 5 };
  if (error === 'expired_token') return { done: true, failure: 'The code expired. Start again.' };
  if (error === 'access_denied') return { done: true, failure: 'GitHub sign-in was declined.' };
  return { done: true, failure: 'GitHub did not sign in.' };
}

export async function runDevicePoll({
  post,
  sleep,
  interval,
  expiresIn,
  now = () => Date.now(),
  shouldStop = () => false,
}) {
  let wait = Number(interval) > 0 ? Number(interval) : 5;
  const deadline = now() + (Number(expiresIn) > 0 ? Number(expiresIn) : 0) * 1000;
  while (now() < deadline) {
    await sleep(wait * 1000);
    if (shouldStop()) return { done: true, cancelled: true };
    let body;
    try {
      body = await post();
    } catch {
      return { done: true, failure: 'The sign-in request failed.' };
    }
    const step = interpretPoll(body, wait);
    if (step.done) return step;
    wait = step.wait;
  }
  return { done: true, failure: 'The code expired. Start again.' };
}

export async function signInWithDevice({
  postJson,
  sleep,
  clientId,
  now,
  shouldStop,
  onCode,
}) {
  let startBody;
  try {
    startBody = await postJson('code', deviceCodeRequest(clientId));
  } catch {
    return { done: true, failure: 'The sign-in request failed.' };
  }
  let start;
  try {
    start = readDeviceStart(startBody);
  } catch {
    return { done: true, failure: 'GitHub did not return a device code.' };
  }
  if (onCode) onCode({ userCode: start.userCode, verification: start.verification });
  return runDevicePoll({
    post: () => postJson('token', tokenPollRequest(clientId, start.deviceCode)),
    sleep,
    interval: start.interval,
    expiresIn: start.expiresIn,
    now,
    shouldStop,
  });
}

export const DEVICE_PAGE = 'https://github.com/login/device';

export function pendingFlow(start, now = Date.now()) {
  return {
    deviceCode: start.deviceCode,
    userCode: start.userCode,
    interval: start.interval,
    expiresAt: now + start.expiresIn * 1000,
  };
}

// One poll loop for a pending device flow. Resume and Check now share it.
export function createDeviceSignIn({
  loadPending,
  savePending,
  clearPending,
  postToken,
  sleep,
  now = () => Date.now(),
  onPending,
  onToken,
  onFailure,
}) {
  let running = null;
  let stop = false;
  let wake = null;
  let pollNow = false;

  function checkNow() {
    if (!running) return begin(true);
    if (wake) {
      const fn = wake;
      wake = null;
      fn();
    } else {
      pollNow = true;
    }
    return running;
  }

  function wait(ms) {
    if (pollNow) {
      pollNow = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        wake = null;
        resolve();
      };
      wake = finish;
      Promise.resolve(sleep(ms)).then(finish, finish);
    });
  }

  async function loop(flow, immediate) {
    let interval = flow.interval;
    let skip = immediate;
    while (now() < flow.expiresAt) {
      if (stop) return { done: true, cancelled: true };
      if (!skip) await wait(interval * 1000);
      skip = false;
      if (stop) return { done: true, cancelled: true };
      if (now() >= flow.expiresAt) break;
      let body;
      try {
        body = await postToken(flow.deviceCode);
      } catch {
        return { done: true, failure: 'The sign-in request failed.' };
      }
      const step = interpretPoll(body, interval);
      if (step.token) {
        if (stop) return { done: true, cancelled: true };
        return step;
      }
      if (stop) return { done: true, cancelled: true };
      if (step.done) return step;
      if (step.wait !== interval) {
        interval = step.wait;
        flow = { ...flow, interval };
        await savePending(flow);
      }
    }
    return { done: true, failure: 'The code expired. Start again.' };
  }

  async function settle(result) {
    if (!result || result.cancelled || result.idle) return result;
    try {
      if (result.token) {
        if (onToken) await onToken(result.token);
      } else if (onFailure) {
        await onFailure(result.failure || 'GitHub did not sign in.');
      }
    } finally {
      await clearPending();
    }
    return result;
  }

  function begin(immediate) {
    if (running) return running;
    running = (async () => {
      try {
        const flow = await loadPending();
        if (!flow) return { done: true, idle: true };
        if (!(now() < flow.expiresAt)) {
          await clearPending();
          return { done: true, idle: true };
        }
        if (onPending) onPending(flow);
        return await settle(await loop(flow, immediate));
      } finally {
        running = null;
        stop = false;
        wake = null;
      }
    })();
    return running;
  }

  return {
    start() {
      return begin(false);
    },
    resume() {
      return begin(true);
    },
    checkNow,
    async cancel() {
      stop = true;
      if (wake) {
        const fn = wake;
        wake = null;
        fn();
      }
      const job = running;
      if (job) await job;
      stop = false;
      await clearPending();
      return { done: true, cancelled: true };
    },
    get active() {
      return Boolean(running);
    },
  };
}

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

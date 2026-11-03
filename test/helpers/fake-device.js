// A stand-in for GitHub's device flow and GET /user behind the relay.
// It models the failure under test: once a code is approved, every token
// request for that code hands out a new value for the same grant and the
// value before it stops working (the security log's oauth_access.regenerate).
// Values are plainly fake and never shaped like a real GitHub token.
const DEVICE_PAGE = 'https://github.com/login/device';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function createFakeDevice({
  deviceCode = 'fake-device-code-0001',
  userCode = 'WXYZ-0001',
  interval = 5,
  expiresIn = 900,
} = {}) {
  const state = {
    approved: false,
    issued: [],
    valid: new Set(),
    tokenPolls: 0,
    pollsAfterApproval: 0,
    userCalls: 0,
    holdUser: null,
  };

  function bearer(headers = {}) {
    const auth = headers.Authorization || headers.authorization || '';
    return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  }

  async function fetchImpl(url, options = {}) {
    const text = String(url);
    for (const value of [deviceCode, ...state.issued]) {
      if (text.includes(value)) throw new Error('a secret leaked into the url');
    }
    if (text.endsWith('/device/code')) {
      return json({
        device_code: deviceCode,
        user_code: userCode,
        interval,
        expires_in: expiresIn,
        verification_uri: DEVICE_PAGE,
      });
    }
    if (text.endsWith('/oauth/access_token')) {
      const body = JSON.parse(options.body || '{}');
      state.tokenPolls += 1;
      if (body.device_code !== deviceCode) {
        return json({ error: 'incorrect_device_code', error_description: 'The device_code provided is not valid.' });
      }
      if (!state.approved) return json({ error: 'authorization_pending' });
      state.pollsAfterApproval += 1;
      state.valid.clear();
      const token = `fake-oauth-value-${String(state.issued.length + 1).padStart(4, '0')}`;
      state.issued.push(token);
      state.valid.add(token);
      return json({ access_token: token, token_type: 'bearer', scope: 'repo' });
    }
    if (text === 'https://api.github.com/user') {
      state.userCalls += 1;
      if (state.holdUser) await state.holdUser;
      if (state.valid.has(bearer(options.headers))) return json({ login: 'octocat' });
      return json({ message: 'Bad credentials' }, 401);
    }
    if (text.startsWith('https://api.github.com/repos/')) {
      if (!state.valid.has(bearer(options.headers))) return json({ message: 'Bad credentials' }, 401);
      return json({ default_branch: 'main' });
    }
    return json({ message: 'Not Found' }, 404);
  }

  return {
    state,
    fetchImpl,
    deviceCode,
    userCode,
    approve() {
      state.approved = true;
    },
    works(token) {
      return state.valid.has(token);
    },
  };
}

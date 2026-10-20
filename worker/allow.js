export const ALLOWED_ORIGIN = 'https://joecoffey.me';

export const ROUTES = Object.freeze({
  '/device/code': 'https://github.com/login/device/code',
  '/oauth/access_token': 'https://github.com/login/oauth/access_token',
});

export function corsHeaders(origin) {
  if (origin !== ALLOWED_ORIGIN) return null;
  return {
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, accept',
    vary: 'Origin',
  };
}

export async function handleRelay(request, fetchImpl = fetch) {
  const origin = request.headers.get('origin');
  const url = new URL(request.url);
  const cors = corsHeaders(origin);
  const target = ROUTES[url.pathname] || '';

  if (!cors) return new Response('Rejected.', { status: 403 });

  if (request.method === 'OPTIONS') {
    if (!target) return new Response('Rejected.', { status: 403, headers: cors });
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== 'POST' || !target) {
    return new Response('Rejected.', { status: 404, headers: cors });
  }

  const contentType = request.headers.get('content-type') || '';
  const allowedType = contentType.startsWith('application/json')
    || contentType.startsWith('application/x-www-form-urlencoded');
  if (!allowedType) return new Response('Rejected.', { status: 415, headers: cors });

  const body = await request.text();
  if (body.length > 8192) return new Response('Rejected.', { status: 413, headers: cors });

  const upstream = await fetchImpl(target, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': contentType,
      accept: 'application/json',
    },
    body,
  });
  if (upstream.status >= 300 && upstream.status < 400) {
    return new Response('Rejected.', { status: 502, headers: cors });
  }
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      ...cors,
      'content-type': upstream.headers.get('content-type') || 'application/json',
    },
  });
}

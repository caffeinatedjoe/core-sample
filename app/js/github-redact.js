const TOKEN_SHAPE = /\b(?:gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]+/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const ACCESS_TOKEN = /access_token(?:=|":\s*")[^&\s"]+/gi;

export function redact(text, secrets = []) {
  let out = String(text ?? '');
  const extras = Array.isArray(secrets) ? secrets : [secrets];
  for (const secret of extras) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(TOKEN_SHAPE, '[redacted]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(ACCESS_TOKEN, 'access_token=[redacted]');
}

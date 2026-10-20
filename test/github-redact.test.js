import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { redact } from '../app/js/github-redact.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'gho_testtokenvalue123456';

test('token shapes and known secrets are removed from error text', () => {
  const text = [
    `Bearer ${TOKEN}`,
    'token ghu_anothersecretvalue',
    'github_pat_1234567890abcdef',
    'access_token=ghs_installsecretvalue',
    'plain secret-phrase-value',
  ].join(' ');
  const cleaned = redact(text, ['secret-phrase-value', TOKEN]);
  assert.equal(cleaned.includes(TOKEN), false);
  assert.equal(cleaned.includes('ghu_anothersecretvalue'), false);
  assert.equal(cleaned.includes('github_pat_1234567890abcdef'), false);
  assert.equal(cleaned.includes('ghs_installsecretvalue'), false);
  assert.equal(cleaned.includes('secret-phrase-value'), false);
  assert.match(cleaned, /Bearer \[redacted\]/);
  assert.match(cleaned, /access_token=\[redacted\]/);
});

test('the app and the worker do not contain a token, a vault name, or relay logging', () => {
  const files = [
    'app/js/github-api.js',
    'app/js/github-device.js',
    'app/js/github-store.js',
    'app/js/github-ui.js',
    'app/js/github-redact.js',
    'app/index.html',
    'worker/allow.js',
    'worker/index.js',
    'worker/wrangler.toml',
  ];
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.equal(/gho_[A-Za-z0-9]{8,}/.test(text), false, file);
    assert.equal(text.includes('zt_vault'), false, file);
    assert.equal(text.includes('client_secret'), false, file);
    assert.equal(text.includes('console.'), false, file);
  }
  const ui = readFileSync(join(root, 'app/js/github-ui.js'), 'utf8');
  assert.equal(ui.includes('textContent = settings.token'), false);
  assert.equal(ui.includes('textContent = result.token'), false);
  const toml = readFileSync(join(root, 'worker/wrangler.toml'), 'utf8');
  assert.equal(/secret|account_id|api_token/i.test(toml), false);
});

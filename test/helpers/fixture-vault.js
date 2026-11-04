// Loads the anonymized sample vault used by the scripted GitHub checks.
// Paths are repo-relative POSIX. Bytes stay as Buffers so PNG/JPEG/GIF/PDF
// round-trip. Nothing here is copied from a real vault.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/vault', import.meta.url));
export const FIXTURE_REPO = 'owner/sample-vault';
export const FIXTURE_BRANCH = 'main';

const NOTE_EXT = /\.md$/i;

export async function loadFixtureVault(root = FIXTURE_DIR) {
  const files = {};
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const path = relative(root, full).split(sep).join('/');
      files[path] = await readFile(full);
    }
  }
  await walk(root);
  return files;
}

export function fixturePaths(files) {
  return Object.keys(files).sort();
}

export function fixtureNotes(files) {
  const notes = {};
  for (const [path, bytes] of Object.entries(files)) {
    if (!NOTE_EXT.test(path)) continue;
    notes[path] = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  }
  return notes;
}

export function fixtureAttachments(files) {
  return fixturePaths(files).filter((path) => !NOTE_EXT.test(path) && !path.split('/').some((part) => part.startsWith('.')));
}

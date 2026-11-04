import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FIXTURE_DIR,
  fixtureAttachments,
  fixtureNotes,
  fixturePaths,
  loadFixtureVault,
} from './helpers/fixture-vault.js';

test('the fixture vault is an anonymized Obsidian-shaped sample', async () => {
  const files = await loadFixtureVault();
  const paths = fixturePaths(files);
  const notes = fixtureNotes(files);
  const attachments = fixtureAttachments(files);

  assert.equal(FIXTURE_DIR.endsWith('test/fixtures/vault'), true);
  assert.equal(paths.includes('.obsidian/app.json'), true);
  assert.equal(paths.includes('Site Log.md'), true);
  assert.equal(paths.includes('Inbox.md'), true);
  assert.equal(paths.includes('Board.md'), true);
  assert.equal(paths.includes('Daily.md'), true);
  assert.equal(paths.includes('Site Log (conflict 2026-10-29 1235).md'), true);

  const app = JSON.parse(files['.obsidian/app.json'].toString('utf8'));
  assert.equal(app.attachmentFolderPath, './assets');

  assert.match(notes['Site Log.md'], /!\[\[image-20261029123530322\.png\]\]/);
  assert.match(notes['Site Log.md'], /!\[\[image-20261029124011200\.jpg\]\]/);
  assert.match(notes['Site Log.md'], /!\[\[image-20261029124500000\.gif\]\]/);
  assert.match(notes['Inbox.md'], /#todo/);
  assert.match(notes['Inbox.md'], /- \[ \] Label the trays #todo/);
  assert.match(notes['Board.md'], /```dataview/);
  assert.match(notes['Board.md'], /^TASK$/m);
  assert.match(notes['Site Log (conflict 2026-10-29 1235).md'], /Leftover conflict copy/);

  assert.deepEqual(attachments, [
    'assets/Site Log/core-notes.pdf',
    'assets/Site Log/image-20261029123530322.png',
    'assets/Site Log/image-20261029124011200.jpg',
    'assets/Site Log/image-20261029124500000.gif',
  ]);
  assert.equal(files['assets/Site Log/image-20261029123530322.png'][0], 0x89);
  assert.equal(files['assets/Site Log/image-20261029124011200.jpg'][0], 0xff);
  assert.equal(files['assets/Site Log/image-20261029124500000.gif'][0], 0x47);
  assert.match(files['assets/Site Log/core-notes.pdf'].toString('latin1'), /^%PDF-/);

  const blob = Buffer.concat(Object.values(files)).toString('utf8').toLowerCase();
  assert.equal(blob.includes('zt_vault'), false);
  assert.equal(blob.includes('caffeinatedjoe'), false);
});

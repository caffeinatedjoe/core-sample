import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeKeyboard, note, openApp, shot, withPhone } from './helpers/webkit-app.js';

const NOTE = 'Comments.md';
const TEXT = [
  'We should <!--c:k3f9-->ship on Friday<!--/c:k3f9--> regardless.',
  '<!--co:k3f9 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship on Friday"',
  'kyle (2026-06-17T10:00:00.000Z): I thought we agreed Thursday?',
  '-->',
  '',
  'Then <!--c:ab12-->launch<!--/c:ab12--> next.',
  '<!--co:ab12 by:me at:2026-11-16T11:00:00.000Z status:open quote:"launch"',
  'me (2026-11-16T11:00:00.000Z): after QA',
  '-->',
  '',
  'Finally <!--c:cd34-->ship it<!--/c:cd34-->.',
  '<!--co:cd34 by:me at:2026-11-16T12:00:00.000Z status:open quote:"ship it"',
  'me (2026-11-16T12:00:00.000Z): last call',
  '-->',
].join('\n');

async function blurEditor(page) {
  await page.evaluate(async () => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.contentDOM.blur();
  });
  await page.waitForFunction(() => !document.querySelector('#source .cm-editor')?.classList.contains('cm-focused'));
}

async function focusEditor(page) {
  await page.evaluate(async () => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.focus();
  });
}

async function caretInComment(page, id) {
  await page.evaluate(async (id) => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    const mark = document.querySelector(`.cm-comment[data-comment-id="${id}"]`);
    const pos = view.posAtDOM(mark, 1);
    view.focus();
    view.dispatch({ selection: { anchor: pos } });
  }, id);
}

async function closeSheet(page) {
  // Headless WebKit has a 0 top inset, so a full sheet covers the scrim.
  // The same click handler runs for a tap on the exposed strip on device.
  await page.evaluate(() => document.getElementById('comment-sheet-scrim')?.click());
  await page.waitForFunction(() => document.getElementById('comment-sheet')?.hidden);
}

async function arrowState(page) {
  return page.evaluate(() => ({
    prev: document.getElementById('comment-sheet-prev')?.hidden !== false,
    next: document.getElementById('comment-sheet-next')?.hidden !== false,
    prevHidden: Boolean(document.getElementById('comment-sheet-prev')?.hidden),
    nextHidden: Boolean(document.getElementById('comment-sheet-next')?.hidden),
  }));
}

async function longPressBubble(page, selector = '.comment-bubble') {
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box, 'bubble to long-press');
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(async ({ selector, from }) => {
    const target = document.querySelector(selector);
    const fire = (type, buttons) => target.dispatchEvent(new PointerEvent(type, {
      pointerId: 31,
      pointerType: 'touch',
      isPrimary: true,
      clientX: from.x,
      clientY: from.y,
      button: 0,
      buttons,
      bubbles: true,
      cancelable: true,
    }));
    fire('pointerdown', 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    fire('pointerup', 0);
  }, { selector, from });
  await page.waitForFunction(() => !document.getElementById('comment-action-sheet')?.hidden);
}

test('webkit preview tap, pill, reply, resolve, next, and composer above keyboard', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await page.waitForSelector('.cm-comment');
    await page.waitForFunction(() => document.getElementById('comments-chip')?.textContent === '💬 3');
    assert.equal(await page.locator('#comments-chip').isVisible(), true);
    await shot(page, 'comments-chip.png');

    await blurEditor(page);
    await page.locator('.cm-comment[data-comment-id="k3f9"]').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet')?.hidden);
    assert.match(await page.locator('#comment-sheet-quote').textContent(), /ship on Friday/);
    assert.match(await page.locator('#comment-sheet-thread').textContent(), /Thursday/);
    await shot(page, 'comments-preview-sheet.png');

    await page.locator('#comment-reply').fill('QA can take Thursday.');
    await page.locator('#comment-send').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet-thread')?.textContent.includes('QA can take Thursday.'));
    const afterReply = await page.evaluate(() => document.getElementById('source').value);
    assert.match(afterReply, /me \(20\d\d-.+\): QA can take Thursday\./);

    await longPressBubble(page, '.comment-bubble');
    await page.locator('.comment-action-rows button', { hasText: 'Resolve thread' }).click();
    await page.waitForFunction(() => document.getElementById('comments-chip')?.textContent === '💬 2');
    assert.match(await page.evaluate(() => document.getElementById('source').value), /status:resolved/);

    await page.locator('#comment-sheet-next').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet-quote')?.textContent.includes('launch'));
    await closeSheet(page);

    await focusEditor(page);
    await caretInComment(page, 'ab12');
    await page.waitForFunction(() => !document.getElementById('comment-pill')?.hidden);
    assert.match(await page.locator('#comment-pill').textContent(), /1 comment/);
    await shot(page, 'comments-edit-pill.png');
    await page.locator('#comment-pill').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet')?.hidden);
    assert.match(await page.locator('#comment-sheet-quote').textContent(), /launch/);

    await page.locator('#comment-reply').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.dataset.size === 'full');
    await fakeKeyboard(page, 336);
    const place = await page.evaluate(() => {
      const app = document.getElementById('app').getBoundingClientRect();
      const composer = document.querySelector('.comment-sheet-composer').getBoundingClientRect();
      return { appBottom: app.bottom, composerBottom: composer.bottom, composerTop: composer.top };
    });
    assert.ok(place.composerBottom <= place.appBottom + 2, `composer ${place.composerBottom} below app ${place.appBottom}`);
    assert.ok(place.composerTop < place.appBottom, 'composer stays on the shrunk shell');
    await shot(page, 'comments-keyboard.png');

    await closeSheet(page);
    await page.locator('#comments-chip').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet-list')?.hidden);
    assert.equal(await page.locator('#comment-sheet-tabs').isHidden(), false);
    assert.equal(await page.locator('#comment-sheet-back').count(), 0);
    await page.locator('.comment-row').first().click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet-thread')?.hidden);
    assert.match(await page.locator('#comment-sheet-quote').textContent(), /./);

    assert.deepEqual(errors, []);
  });
});

test('webkit arrows hide at the ends and on a single comment', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await blurEditor(page);
    await page.locator('.cm-comment[data-comment-id="k3f9"]').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet')?.hidden);
    let arrows = await arrowState(page);
    assert.equal(arrows.prevHidden, true, 'first comment hides previous');
    assert.equal(arrows.nextHidden, false, 'first comment shows next');

    await page.locator('#comment-sheet-next').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet-quote')?.textContent.includes('launch'));
    arrows = await arrowState(page);
    assert.equal(arrows.prevHidden, false, 'middle comment shows previous');
    assert.equal(arrows.nextHidden, false, 'middle comment shows next');

    await page.locator('#comment-sheet-next').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet-quote')?.textContent.includes('ship it'));
    arrows = await arrowState(page);
    assert.equal(arrows.prevHidden, false, 'last comment shows previous');
    assert.equal(arrows.nextHidden, true, 'last comment hides next');

    await closeSheet(page);
    const single = [
      'Only <!--c:one1-->one<!--/c:one1--> here.',
      '<!--co:one1 by:me at:2026-11-16T12:00:00.000Z status:open quote:"one"',
      'me (2026-11-16T12:00:00.000Z): solo',
      '-->',
    ].join('\n');
    await openApp(page, url, [note('Single.md', single)], 'Single.md');
    await blurEditor(page);
    await page.locator('.cm-comment[data-comment-id="one1"]').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet')?.hidden);
    arrows = await arrowState(page);
    assert.equal(arrows.prevHidden, true, 'single comment hides previous');
    assert.equal(arrows.nextHidden, true, 'single comment hides next');

    assert.deepEqual(errors, []);
  });
});

test('webkit composer focus snaps full and keeps the latest entry above it', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    const body = [
      'We <!--c:k3f9-->ship<!--/c:k3f9--> Friday.',
      '<!--co:k3f9 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship"',
      'kyle (2026-06-17T10:00:00.000Z): Can we wait?',
      'me (2026-06-17T10:05:00.000Z): No, Friday works.',
      'me (2026-06-17T10:06:00.000Z): Already booked QA.',
      'grok (2026-06-17T11:00:00.000Z): I can review Thursday night.',
      'me (2026-06-17T11:05:00.000Z): Latest note sits above the composer.',
      '-->',
    ].join('\n');
    await openApp(page, url, [note(NOTE, body)], NOTE);
    await blurEditor(page);
    await page.locator('.cm-comment[data-comment-id="k3f9"]').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet')?.hidden);
    assert.equal(await page.locator('#comment-sheet').getAttribute('data-size'), 'half');
    await page.locator('#comment-reply').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.dataset.size === 'full');
    const layout = await page.evaluate(() => {
      const last = [...document.querySelectorAll('.comment-bubble-row')].at(-1)?.getBoundingClientRect();
      const composer = document.querySelector('.comment-sheet-composer')?.getBoundingClientRect();
      const thread = document.getElementById('comment-sheet-thread');
      return {
        lastBottom: last?.bottom ?? -1,
        lastTop: last?.top ?? -1,
        composerTop: composer?.top ?? -1,
        text: thread?.textContent || '',
      };
    });
    assert.match(layout.text, /Latest note sits above the composer/);
    assert.ok(layout.lastBottom <= layout.composerTop + 4, `latest ${layout.lastBottom} should sit above composer ${layout.composerTop}`);
    assert.ok(layout.lastTop < layout.composerTop, 'latest entry is visible above the composer');
    assert.deepEqual(errors, []);
  });
});

async function selectText(page, start, end) {
  await page.evaluate(async ({ start, end }) => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.focus();
    view.dispatch({ selection: { anchor: start, head: end } });
  }, { start, end });
}

test('webkit creates, edits, reacts, and deletes from the action sheet', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    const body = [
      'Plan the launch next week.',
      '',
      '| k | v |',
      '| - | - |',
      '| x | y |',
    ].join('\n');
    await openApp(page, url, [note('Create.md', body)], 'Create.md');
    await focusEditor(page);
    const planStart = body.indexOf('launch');
    await selectText(page, planStart, planStart + 'launch next week'.length);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
    await page.waitForFunction(() => !document.querySelector('[data-format="comment"]').disabled);
    await page.locator('[data-format="comment"]').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet')?.hidden);
    assert.equal(await page.locator('#comment-sheet').getAttribute('data-size'), 'full');
    await page.locator('#comment-reply').fill('Need a QA buffer.');
    await page.locator('#comment-send').click();
    await page.waitForFunction(() => document.getElementById('comments-chip')?.textContent === '💬 1');
    let source = await page.evaluate(() => document.getElementById('source').value);
    assert.match(source, /<!--c:[A-Za-z0-9]+-->launch next week<!--\/c:/);
    assert.match(source, /Need a QA buffer\./);

    await closeSheet(page);
    await selectText(page, planStart, planStart + 'launch'.length);
    await page.locator('[data-format="comment"]').click();
    await page.locator('#comment-composer-cancel').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.hidden);
    assert.doesNotMatch(await page.evaluate(() => document.getElementById('source').value), /<!--c:.*-->launch<!--/);

    await selectText(page, planStart, planStart + 'launch next week'.length);
    await page.locator('[data-format="comment"]').click();
    await page.locator('#comment-composer-cancel').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.hidden);

    await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.line(1).from } });
    });
    await page.locator('[data-format="comment"]').click();
    assert.equal(await page.locator('#comment-sheet').getAttribute('data-size'), 'full');
    await page.locator('#comment-reply').fill('Line note');
    await page.locator('#comment-send').click();
    source = await page.evaluate(() => document.getElementById('source').value);
    assert.match(source, /Line note/);
    await page.waitForFunction(() => document.getElementById('comment-sheet-thread')?.textContent.includes('Line note'));

    await longPressBubble(page, '.comment-bubble.is-own');
    await page.locator('.comment-action-rows button', { hasText: 'Edit' }).click();
    await page.locator('#comment-reply').fill('Edited note');
    await page.locator('#comment-send').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet-thread')?.textContent.includes('Edited note'));

    await longPressBubble(page, '.comment-bubble.is-own');
    await page.locator('#comment-action-reactions [data-emoji="👍"]').click();
    await page.waitForFunction(() => document.querySelector('.comment-reaction-chip')?.textContent.includes('👍'));
    await page.locator('.comment-reaction-chip').first().click();
    source = await page.evaluate(() => document.getElementById('source').value);
    assert.doesNotMatch(source, /\+👍/);

    page.once('dialog', (dialog) => dialog.accept());
    await longPressBubble(page, '.comment-bubble');
    await page.locator('.comment-action-rows button', { hasText: 'Delete comment' }).click();
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.hidden);

    assert.deepEqual(errors, []);
  });
});

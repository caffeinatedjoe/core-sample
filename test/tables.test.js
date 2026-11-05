import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, ensureSyntaxTree } from '../app/vendor/codemirror.js';
import { fitCell, parseTable, tableCellChange } from '../app/js/tables.js';
import { liveSpecs, markdownLanguage } from '../app/js/live-rules.js';

function stateOf(doc) {
  const state = EditorState.create({ doc, extensions: [EditorState.lineSeparator.of('\n'), markdownLanguage.extension] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

function tableOf(doc) {
  return parseTable(doc, 0);
}

test('parseTable reads header, alignment, and padded body cells', () => {
  const doc = '| Name | Depth |\n| :--- | ----: |\n| A    |  12.5 |';
  const table = tableOf(doc);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.aligns, ['left', 'right']);
  assert.equal(table.rows[0].kind, 'header');
  assert.equal(table.rows[0].cells[0].text, 'Name');
  assert.equal(table.rows[1].cells[0].text, 'A');
  assert.equal(table.rows[1].cells[1].text, '12.5');
  assert.equal(doc.slice(table.rows[1].cells[0].from, table.rows[1].cells[0].to), ' A    ');
  assert.equal(doc.slice(table.rows[1].cells[1].from, table.rows[1].cells[1].to), '  12.5 ');
});

test('parseTable keeps CRLF out of cell ranges', () => {
  const doc = '| a | b |\r\n| --- | --- |\r\n| c | d |\r';
  const table = tableOf(doc);
  assert.equal(table.rows[1].cells[0].text, 'c');
  assert.equal(doc.slice(table.rows[1].from, table.rows[1].to).endsWith('\r'), true);
  assert.equal(doc.slice(table.rows[1].cells[0].from, table.rows[1].cells[0].to).includes('\r'), false);
});

test('a shorter cell edit pads so later pipes do not move', () => {
  const doc = '| Name | Depth |\n| --- | --- |\n| Alpha | 12 |';
  const table = tableOf(doc);
  const change = tableCellChange(table, 1, 0, 'A');
  const next = doc.slice(0, change.from) + change.insert + doc.slice(change.to);
  assert.equal(next, '| Name | Depth |\n| --- | --- |\n| A     | 12 |');
  assert.equal(next.slice(change.to), doc.slice(table.rows[1].cells[0].to));
});

test('a longer cell edit only rewrites that cell', () => {
  const doc = '| Name | Depth |\n| --- | --- |\n| A | 12 |';
  const table = tableOf(doc);
  const change = tableCellChange(table, 1, 0, 'Basalt');
  const next = `${doc.slice(0, change.from)}${change.insert}${doc.slice(change.to)}`;
  assert.equal(next, '| Name | Depth |\n| --- | --- |\n| Basalt | 12 |');
  assert.equal(next.endsWith('| 12 |'), true);
  assert.equal(next.startsWith('| Name | Depth |'), true);
});

test('fitCell escapes pipes and flattens newlines', () => {
  assert.equal(fitCell(' a ', 'x|y').includes('\\|'), true);
  assert.equal(fitCell(' a ', 'x\ny'), ' x y ');
});

test('untouched cells are a no-op change', () => {
  const doc = '| a | b |\n| --- | --- |\n| c | d |';
  const table = tableOf(doc);
  const change = tableCellChange(table, 1, 0, 'c');
  assert.equal(change.noop, true);
  assert.equal(change.insert, table.rows[1].cells[0].raw);
});

test('Live Preview replaces a table off the caret and shows source on it', () => {
  const doc = 'before\n| Rock | m |\n| --- | --- |\n| clay | 4 |\nafter';
  const state = stateOf(doc);
  const off = liveSpecs(state, { ranges: [] });
  const widget = off.find((spec) => spec.widget?.kind === 'table');
  assert.ok(widget);
  assert.equal(widget.widget.table.rows[1].cells[0].text, 'clay');
  const on = liveSpecs(state, { ranges: [{ from: doc.indexOf('clay'), to: doc.indexOf('clay') }] });
  assert.equal(on.some((spec) => spec.widget?.kind === 'table'), false);
  assert.ok(on.some((spec) => spec.type === 'line' && spec.cls.includes('cm-table')));
});

test('drawing a table never edits the source, including tabs and trailing spaces', () => {
  const original = '| a\t| b  |\r\n| --- | --- |\r\n| c | d |\r\n';
  const state = stateOf(original);
  liveSpecs(state, { ranges: [] });
  liveSpecs(state, { ranges: [{ from: 0, to: 0 }] });
  assert.equal(state.doc.toString(), original);
});

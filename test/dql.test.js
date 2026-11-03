import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dataviewResult, parseDql, runDql, UNSUPPORTED_NOTE } from '../app/js/dql.js';
import { createTaskIndex } from '../app/js/task-index.js';

const JOE_QUERY = `TASK
WHERE !completed
WHERE contains(text, "#todo")`;

function sampleIndex() {
  const index = createTaskIndex();
  index.rebuild([
    {
      path: 'Inbox.md',
      content: [
        '- [ ] Buy milk #todo',
        '- [x] Done already #todo',
        '- [ ] No tag here',
        '- [ ] Nested parent #todo',
        '\t- [ ] child without tag',
      ].join('\n'),
    },
    { path: 'Projects/Plan.md', content: '- [ ] Write summary #todo\n- [/] In progress #todo\n' },
    { path: 'Projects/Skip.md', content: '- [ ] Other work\n' },
    { path: 'Tags.md', content: '---\ntags: [later]\n---\n- [ ] From frontmatter\n' },
  ]);
  return index;
}

function texts(result) {
  return result.groups.flatMap((group) => group.tasks.map((task) => `${group.name}:${task.text}`));
}

test("Joe's TASK query lists unfinished #todo tasks grouped by file", () => {
  const parsed = parseDql(JOE_QUERY);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.type, 'task');
  const result = runDql(parsed, sampleIndex());
  assert.equal(result.supported, true);
  assert.deepEqual(result.groups.map((group) => group.name), ['Inbox', 'Plan']);
  assert.deepEqual(texts(result), [
    'Inbox:Buy milk #todo',
    'Inbox:Nested parent #todo',
    'Inbox:child without tag',
    'Plan:Write summary #todo',
    'Plan:In progress #todo',
  ]);
});

test('FROM folder, tag, and/or combinations filter pages before WHERE', () => {
  const index = sampleIndex();
  const folder = runDql(parseDql('TASK FROM "Projects" WHERE !completed'), index);
  assert.deepEqual(texts(folder), [
    'Plan:Write summary #todo',
    'Plan:In progress #todo',
    'Skip:Other work',
  ]);
  const tagged = runDql(parseDql('TASK FROM #later'), index);
  assert.deepEqual(texts(tagged), ['Tags:From frontmatter']);
  const mixed = runDql(parseDql('TASK FROM "Projects" and -#later WHERE contains(text, "#todo")'), index);
  assert.deepEqual(texts(mixed), ['Plan:Write summary #todo', 'Plan:In progress #todo']);
  const orQuery = runDql(parseDql('TASK FROM "Inbox.md" or #later WHERE !completed'), index);
  assert.ok(orQuery.groups.some((group) => group.name === 'Inbox'));
  assert.ok(orQuery.groups.some((group) => group.name === 'Tags'));
});

test('WHERE supports completed, contains, file fields, comparisons, and boolean ops', () => {
  const index = sampleIndex();
  const done = runDql(parseDql('TASK WHERE completed AND contains(text, "#todo")'), index);
  assert.deepEqual(texts(done), ['Inbox:Done already #todo']);
  const named = runDql(parseDql('TASK WHERE file.name == "Plan" && !completed'), index);
  assert.deepEqual(texts(named).every((row) => row.startsWith('Plan:')), true);
  const pathNe = runDql(parseDql('TASK WHERE file.path != "Inbox.md" AND contains(tags, "#todo") AND !completed'), index);
  assert.deepEqual(texts(pathNe), ['Plan:Write summary #todo', 'Plan:In progress #todo']);
  const orWhere = runDql(parseDql('TASK WHERE contains(text, "milk") || contains(text, "summary")'), index);
  assert.deepEqual(texts(orWhere), ['Inbox:Buy milk #todo', 'Plan:Write summary #todo']);
  const caseFold = runDql(parseDql('TASK WHERE contains(text, "#TODO") AND !completed AND file.name == "Inbox"'), index);
  assert.ok(texts(caseFold).includes('Inbox:Buy milk #todo'));
  const tagged = runDql(parseDql('TASK WHERE contains(tags, "#TODO") AND file.name == "Plan" AND !completed'), index);
  assert.deepEqual(texts(tagged), ['Plan:Write summary #todo', 'Plan:In progress #todo']);
  const fully = runDql(parseDql('TASK WHERE fullyCompleted'), index);
  assert.deepEqual(texts(fully), ['Inbox:Done already #todo']);
});

test('SORT, GROUP BY file, and LIMIT apply in order', () => {
  const index = sampleIndex();
  const sorted = runDql(parseDql('TASK WHERE contains(text, "#todo") AND !completed SORT text ASC'), index);
  assert.deepEqual(sorted.groups.map((group) => group.name), ['Inbox', 'Plan']);
  assert.deepEqual(texts(sorted), [
    'Inbox:Buy milk #todo',
    'Inbox:Nested parent #todo',
    'Inbox:child without tag',
    'Plan:In progress #todo',
    'Plan:Write summary #todo',
  ]);
  const limited = runDql(parseDql('TASK WHERE contains(text, "#todo") AND !completed SORT text ASC LIMIT 2'), index);
  assert.deepEqual(texts(limited), ['Inbox:Buy milk #todo', 'Plan:In progress #todo']);
  const grouped = runDql(parseDql('TASK WHERE !completed GROUP BY file'), index);
  assert.ok(grouped.groups.length >= 2);
  assert.ok(grouped.groups.every((group) => group.path && group.name));
});

test('CRLF query text parses the same as LF', () => {
  const crlf = parseDql('TASK\r\nWHERE !completed\r\nWHERE contains(text, "#todo")');
  assert.equal(crlf.ok, true);
  const result = runDql(crlf, sampleIndex());
  assert.equal(result.supported, true);
  assert.ok(result.groups.some((group) => group.name === 'Inbox'));
});

test('unsupported queries never invent a result', () => {
  const index = sampleIndex();
  const cases = [
    'LIST',
    'TABLE file.name',
    'CALENDAR file.ctime',
    'TASK WHERE length(text) > 3',
    'TASK WHERE due = date("2024-01-01")',
    'TASK FLATTEN file.tasks',
    'TASK FROM [[Plan]]',
    'TASK GROUP BY completed',
  ];
  for (const source of cases) {
    const parsed = parseDql(source);
    assert.equal(parsed.ok, false, source);
    const result = dataviewResult(source, 'dataview', index);
    assert.equal(result.supported, false, source);
    assert.equal(result.message, UNSUPPORTED_NOTE);
  }
  const js = dataviewResult('TASK', 'dataviewjs', index);
  assert.equal(js.supported, false);
  assert.equal(js.message, UNSUPPORTED_NOTE);
});

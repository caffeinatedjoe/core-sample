import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProperties, propertyChange } from '../app/js/frontmatter.js';

test('parseProperties reads scalars, flow lists, and block lists', () => {
  const yaml = 'title: Core\ndraft: false\ntags: [a, b]\nmore:\n  - one\n  - two\n';
  const parsed = parseProperties(yaml, 0);
  assert.equal(parsed.fields[0].value, 'Core');
  assert.equal(parsed.fields[1].kind, 'bool');
  assert.deepEqual(parsed.fields[2].value, ['a', 'b']);
  assert.equal(parsed.fields[2].flow, true);
  assert.deepEqual(parsed.fields[3].value, ['one', 'two']);
  assert.equal(parsed.fields[3].flow, false);
});

test('propertyChange rewrites only the value and keeps later lines', () => {
  const yaml = 'title: Core  \r\ntags: [a]\r\n';
  const field = parseProperties(yaml, 0).fields[0];
  const change = propertyChange(field, 'Basalt');
  const next = yaml.slice(0, change.from) + change.insert + yaml.slice(change.to);
  assert.equal(next, 'title: Basalt\r\ntags: [a]\r\n');
});

test('boolean and list edits keep their YAML style', () => {
  const yaml = 'draft: yes\ntags: [a, b]\n';
  const parsed = parseProperties(yaml, 0);
  const draft = propertyChange(parsed.fields[0], false);
  assert.equal((yaml.slice(0, draft.from) + draft.insert + yaml.slice(draft.to)), 'draft: no\ntags: [a, b]\n');
  const tags = propertyChange(parsed.fields[1], 'a, c');
  assert.equal((yaml.slice(0, tags.from) + tags.insert + yaml.slice(tags.to)), 'draft: yes\ntags: [a, c]\n');
});

test('a quoted value that needs quoting stays quoted', () => {
  const yaml = 'title: "A: B"\n';
  const field = parseProperties(yaml, 0).fields[0];
  assert.equal(field.value, 'A: B');
  const change = propertyChange(field, 'C: D');
  assert.equal(yaml.slice(0, change.from) + change.insert + yaml.slice(change.to), 'title: "C: D"\n');
});

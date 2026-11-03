// In-memory task index. Built from IndexedDB notes at launch, then updated
// only for paths that change. Query time is a local filter — no network.
import { indexNote } from './tasks.js';
import { isIgnoredPath } from './vault-paths.js';

const LOCAL_COPY_NAME = / \((?:(?:conflict|backup) \d{4}-\d{2}-\d{2} \d{4}(?:-\d+)?|imported(?: \d+)?)\)\.md$/i;

// Leftover copies the app writes beside a real note. They stay in the
// sidebar, but a #todo in one must not appear twice in a TASK query.
export function isIndexableNote(file) {
  if (!file || typeof file.path !== 'string' || !file.path) return false;
  if (file.kind && file.kind !== 'markdown') return false;
  if (file.trashedAt || isIgnoredPath(file.path)) return false;
  if (file.conflictCopy || file.backup) return false;
  if (LOCAL_COPY_NAME.test(file.path)) return false;
  return true;
}

export function createTaskIndex() {
  const notes = new Map();
  let tasks = [];

  function recompute() {
    tasks = [];
    for (const note of notes.values()) tasks.push(...note.tasks);
  }

  function put(path, content) {
    if (!path) return;
    notes.set(path, indexNote(content, path));
  }

  return {
    rebuild(files) {
      notes.clear();
      for (const file of files || []) {
        if (!isIndexableNote(file)) continue;
        put(file.path, file.content);
      }
      recompute();
    },
    replace(path, content) {
      if (!isIndexableNote({ path, content })) {
        if (notes.delete(path)) recompute();
        return;
      }
      put(path, content);
      recompute();
    },
    remove(path) {
      if (!notes.delete(path)) return;
      recompute();
    },
    rename(from, to, content) {
      notes.delete(from);
      if (to && isIndexableNote({ path: to, content })) put(to, content);
      recompute();
    },
    notes() {
      return [...notes.values()];
    },
    tasks() {
      return tasks;
    },
    tasksIn(path) {
      return notes.get(path)?.tasks || [];
    },
  };
}

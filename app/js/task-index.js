// In-memory task index. Built from IndexedDB notes at launch, then updated
// only for paths that change. Query time is a local filter — no network.
import { indexNote } from './tasks.js';

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
        if (!file || typeof file.path !== 'string' || !file.path) continue;
        put(file.path, file.content);
      }
      recompute();
    },
    replace(path, content) {
      put(path, content);
      recompute();
    },
    remove(path) {
      if (!notes.delete(path)) return;
      recompute();
    },
    rename(from, to, content) {
      notes.delete(from);
      if (to) put(to, content);
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

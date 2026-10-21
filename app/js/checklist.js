// Task markers and fenced-code rules. The renderer uses these too, so a
// checkbox inside a code fence is never a button and never a toggle target.

export function parseFenceLine(line) {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  return {
    char: match[2][0],
    count: match[2].length,
    info: match[3].trim(),
  };
}

export function closesFence(line, open) {
  const fence = parseFenceLine(line);
  if (!fence || !open) return false;
  if (fence.info) return false;
  return fence.char === open.char && fence.count >= open.count;
}

// `- [ ]`, `* [x]`, `+ [X]`. Leading spaces and tabs are kept as-is so a
// nested vault line toggles without the indent changing. The mark is the
// single character inside the brackets.
export function parseTask(line) {
  const match = /^([ \t]*)([-*+])([ \t]+)\[([ xX])\](.*)$/.exec(line);
  if (!match) return null;
  const markIndex = match[1].length + match[2].length + match[3].length + 1;
  return {
    indent: match[1],
    bullet: match[2],
    gap: match[3],
    mark: match[4],
    markIndex,
    checked: match[4].toLowerCase() === 'x',
    rest: match[5],
    text: match[5].replace(/^\s/, ''),
  };
}

function walk(markdown, visit) {
  const lines = String(markdown ?? '').split('\n');
  let open = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = parseFenceLine(line);
    if (!open && fence) {
      visit({ line, index, inFence: true, fence: true });
      open = fence;
      continue;
    }
    if (open && closesFence(line, open)) {
      visit({ line, index, inFence: true, fence: true });
      open = null;
      continue;
    }
    visit({ line, index, inFence: open !== null, fence: false });
  }
  return lines;
}

export function listTasks(markdown) {
  const tasks = [];
  walk(markdown, ({ line, index, inFence }) => {
    if (inFence) return;
    const task = parseTask(line);
    if (!task) return;
    tasks.push({ ...task, index: tasks.length, line: index });
  });
  return tasks;
}

// Flips one mark character. Same length, so selection offsets stay valid.
export function toggleChecklist(markdown, taskIndex) {
  const source = String(markdown ?? '');
  if (!Number.isInteger(taskIndex) || taskIndex < 0) return source;
  const lines = source.split('\n');
  let seen = 0;
  let open = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = parseFenceLine(line);
    if (!open && fence) {
      open = fence;
      continue;
    }
    if (open && closesFence(line, open)) {
      open = null;
      continue;
    }
    if (open) continue;
    const task = parseTask(line);
    if (!task) continue;
    if (seen === taskIndex) {
      const next = task.checked ? ' ' : 'x';
      lines[index] = line.slice(0, task.markIndex) + next + line.slice(task.markIndex + 1);
      return lines.join('\n');
    }
    seen += 1;
  }
  return source;
}

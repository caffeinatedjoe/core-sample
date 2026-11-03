// A minimal page for mountGithub: the sheet's elements, document and window
// listeners, and a clipboard. Shared by the sign-in tests.
import { DEVICE_PAGE } from '../../app/js/github-device.js';

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function element(id) {
  const node = {
    id,
    hidden: false,
    value: '',
    textContent: '',
    href: '',
    target: '',
    rel: '',
    focused: false,
    scrolled: false,
    listeners: {},
  };
  node.addEventListener = (type, fn) => {
    (node.listeners[type] ||= []).push(fn);
  };
  node.focus = () => {
    node.focused = true;
  };
  node.scrollIntoView = () => {
    node.scrolled = true;
  };
  node.click = () => {
    for (const fn of node.listeners.click || []) fn({ target: node, preventDefault() {} });
  };
  node.setAttribute = () => {};
  return node;
}

export function page(fetchImpl) {
  const ids = [
    'github-sheet', 'github-client-id', 'github-relay', 'github-repo', 'github-branch', 'github-root',
    'github-status', 'github-auth-failure', 'github-device', 'github-signin-state', 'github-user-code', 'github-verify',
    'github-try-again', 'github-target', 'github-login', 'github-sign-in-again', 'github-storage',
    'github-choice', 'github-confirm-replace',
    'github-disconnect-confirm', 'github-erase-confirm', 'github-connect', 'github-export-backup', 'github-file-bar',
    'github-file-status', 'github-button', 'github-close', 'github-save-config', 'github-open-github',
    'github-check-now', 'github-cancel', 'github-save-repo', 'github-download', 'github-alongside',
    'github-export-replace', 'github-disconnect', 'github-disconnect-yes', 'github-erase',
    'github-erase-yes', 'github-push', 'github-pull',
  ];
  const nodes = {};
  for (const id of ids) nodes[id] = element(id);
  for (const id of ['github-sheet', 'github-device', 'github-try-again', 'github-target', 'github-sign-in-again', 'github-auth-failure', 'github-choice', 'github-confirm-replace', 'github-disconnect-confirm', 'github-erase-confirm', 'github-file-bar']) {
    nodes[id].hidden = true;
  }
  nodes['github-verify'].href = DEVICE_PAGE;
  const opens = [];
  const copies = [];
  const doc = {
    visibilityState: 'visible',
    listeners: {},
    body: element('body'),
    getElementById: (id) => nodes[id],
    addEventListener(type, fn) {
      (doc.listeners[type] ||= []).push(fn);
    },
    dispatch(type) {
      for (const fn of doc.listeners[type] || []) fn({ type });
    },
  };
  const view = {
    listeners: {},
    navigator: {
      clipboard: {
        writeText(text) {
          copies.push(text);
          return view.copyResult(text);
        },
      },
    },
    copyResult: () => Promise.resolve(),
    open(url) {
      opens.push(url);
      return view.openResult;
    },
    openResult: {},
    fetch: fetchImpl,
    setTimeout,
    addEventListener(type, fn) {
      (view.listeners[type] ||= []).push(fn);
    },
    dispatch(type) {
      for (const fn of view.listeners[type] || []) fn({ type, persisted: true });
    },
  };
  doc.defaultView = view;
  return { doc, nodes, view, opens, copies };
}

export function domText(nodes) {
  return Object.values(nodes).map((node) => [node.textContent, node.value, node.href].join('\n')).join('\n');
}

export async function until(read) {
  for (let i = 0; i < 30; i += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out');
}

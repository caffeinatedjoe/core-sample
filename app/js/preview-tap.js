// Decides what a preview tap is allowed to do. External http(s) and mailto
// links must keep the browser's default action: iOS standalone ignores
// target=_blank and window.open, and a prevented click does nothing.

export function planPreviewClick(target) {
  const origin = target?.nodeType === 1 ? target : target?.parentElement;
  if (!origin || typeof origin.closest !== 'function') {
    return { type: 'none', preventDefault: false };
  }

  const wiki = origin.closest('[data-wikilink]');
  if (wiki) {
    return {
      type: 'wikilink',
      preventDefault: true,
      target: wiki.dataset.wikilink || '',
      heading: wiki.dataset.heading || '',
    };
  }

  const task = origin.closest('[data-task-index]');
  if (task) {
    return {
      type: 'task',
      preventDefault: true,
      index: Number(task.dataset.taskIndex),
    };
  }

  const image = origin.closest('.embed-image');
  if (image) {
    const src = image.getAttribute('src') || '';
    return {
      type: 'image',
      preventDefault: true,
      src,
      alt: image.getAttribute('alt') || '',
    };
  }

  const anchor = origin.closest('a[href]');
  if (anchor) {
    const href = anchor.getAttribute('href') || '';
    const external = /^(https?:|mailto:)/i.test(href.trim());
    return {
      type: external ? 'external' : 'local-link',
      preventDefault: !external,
      href,
    };
  }

  return { type: 'none', preventDefault: false };
}

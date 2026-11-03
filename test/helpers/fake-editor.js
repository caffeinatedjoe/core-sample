// Stands in for live-editor.js in tests that mount the app on a fake DOM.
// It keeps the text, draws one `.embed` node per `![[image]]` so image
// hydration runs, and lets a test tap a node the way the editor would.
import { planPreviewClick } from '../../app/js/preview-tap.js';

export function fakeEditorFactory(createElement) {
  const made = [];
  const factory = (host, hooks) => {
    let text = '';
    const draw = () => {
      host.replaceChildren();
      for (const match of text.matchAll(/!\[\[([^\]|]+)[^\]]*\]\]/g)) {
        const node = createElement('span');
        node.className = 'embed';
        node.dataset.embed = match[1];
        node.dataset.live = 'image';
        host.append(node);
        hooks.hydrate(node);
      }
    };
    const editor = {
      hooks,
      selectionStart: 0,
      selectionEnd: 0,
      scrollTop: 0,
      readOnly: false,
      scrollEl: host,
      load(next) {
        text = String(next ?? '');
        draw();
      },
      get value() {
        return text;
      },
      set value(next) {
        text = String(next ?? '');
      },
      type(next) {
        text = next;
        hooks.onChange();
      },
      tap(node) {
        hooks.onTap(planPreviewClick(node), node.closest('[data-live]') || node, { preventDefault() {} });
      },
      focus() {},
      hasFocus: () => false,
      measure() {},
      scrollToPos() {},
      posOf: () => -1,
      images: () => [],
      embedNodes: () => host.querySelectorAll('.embed'),
      contains: () => false,
    };
    made.push(editor);
    return editor;
  };
  factory.made = made;
  return factory;
}

// The parts of CodeMirror 6 that Core Sample uses. `npm run editor` bundles
// this into app/vendor/codemirror.js. @codemirror/lang-markdown is left out:
// it pulls in the HTML, CSS and JavaScript languages for nested code.
export {
  Compartment,
  EditorSelection,
  EditorState,
  Transaction,
} from '@codemirror/state';
export {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder,
} from '@codemirror/view';
export {
  Language,
  defineLanguageFacet,
  ensureSyntaxTree,
  syntaxTree,
} from '@codemirror/language';
export {
  defaultKeymap,
  history,
  historyKeymap,
  redo,
  undo,
} from '@codemirror/commands';
export { GFM, parser as markdownParser } from '@lezer/markdown';

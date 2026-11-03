// Obsidian and Git keep their own state in dot-folders and dot-files
// (.obsidian/, .trash/, .git*, .github/). Core Sample never lists, uploads,
// deletes, or makes conflicts from them, so a tree it writes leaves them as-is.
export function isIgnoredPath(path) {
  return String(path ?? '')
    .split('/')
    .some((part) => part.startsWith('.'));
}

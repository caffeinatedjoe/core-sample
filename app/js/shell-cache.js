// Classic script. The service worker loads it with importScripts.
// Navigation, HTML, the worker script, and app JS/CSS revalidate.
// Icons and the manifest stay cache-first so offline launch still paints.
function shellRequestKind(relativePath) {
  if (relativePath === './' || relativePath === './index.html' || relativePath === './sw.js') {
    return 'network-first';
  }
  if (/\.(?:js|mjs|css)$/.test(relativePath)) return 'network-first';
  return 'cache-first';
}

import { openDatabase } from './db.js';
import { APP_BUILD } from './version.js';
import { mountApp } from './view.js';

function bindViewport() {
  const apply = () => {
    const viewport = window.visualViewport;
    let keyboard = 0;
    if (viewport) {
      // offsetTop is the layout scroll iOS applies when a field is focused.
      // It must shrink the bottom, not move the frame upward under the status bar.
      const overlap = window.innerHeight - viewport.height - viewport.offsetTop;
      if (overlap > 0) keyboard = overlap;
    }
    document.documentElement.style.setProperty('--keyboard-inset', `${Math.round(keyboard)}px`);
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  };
  window.visualViewport?.addEventListener('resize', apply);
  window.visualViewport?.addEventListener('scroll', apply);
  window.addEventListener('scroll', apply, { passive: true });
  apply();
}

function registerWorker(flush) {
  if (!('serviceWorker' in navigator)) return;
  // The first install has no controller yet, so it must not reload. Once this
  // script is running, a later worker taking control flushes the open note
  // and reloads. updateViaCache: 'none' makes the browser revalidate sw.js
  // instead of trusting the HTTP cache. iOS standalone often skips that check
  // until something calls update(), so we do it on launch and whenever the
  // app becomes visible again.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    Promise.resolve()
      .then(() => flush?.())
      .catch(() => {})
      .finally(() => window.location.reload());
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then((registration) => {
      const check = () => registration.update().catch(() => {});
      check();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    })
    .catch(() => {});
}

function requestPersistence() {
  if (!navigator.storage?.persist) return;
  navigator.storage.persist().catch(() => {});
}

function showBootError() {
  const el = document.getElementById('boot-error');
  if (!el) return;
  el.hidden = false;
  el.textContent = 'Core Sample could not open storage on this device. Nothing was deleted by this screen.';
}

function clearShellQuery() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('shell')) return;
  url.searchParams.delete('shell');
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(null, '', next);
}

async function main() {
  clearShellQuery();
  const build = document.getElementById('build-version');
  if (build) build.textContent = APP_BUILD;
  bindViewport();
  requestPersistence();
  const db = await openDatabase();
  const app = mountApp(document, db);
  registerWorker(() => app.flush());
  await app.start();
  document.addEventListener('pointerdown', requestPersistence, { once: true });
}

main().catch(() => {
  showBootError();
});

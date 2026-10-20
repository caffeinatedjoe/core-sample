import { openDatabase } from './db.js';
import { mountApp } from './view.js';

function bindViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const apply = () => {
    document.documentElement.style.setProperty('--vv-top', `${viewport.offsetTop}px`);
    document.documentElement.style.setProperty('--vv-height', `${viewport.height}px`);
  };
  viewport.addEventListener('resize', apply);
  viewport.addEventListener('scroll', apply);
  apply();
}

function registerWorker(flush) {
  if (!('serviceWorker' in navigator)) return;
  // The page that is already open does not have this listener until it loads
  // the new script. An update therefore applies on the next launch. Once this
  // script is running, a later worker taking control flushes and reloads.
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
  navigator.serviceWorker.register('./sw.js').catch(() => {});
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

async function main() {
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

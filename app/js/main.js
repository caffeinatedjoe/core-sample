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

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
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
  registerWorker();
  requestPersistence();
  const db = await openDatabase();
  const app = mountApp(document, db);
  await app.start();
  document.addEventListener('pointerdown', requestPersistence, { once: true });
}

main().catch(() => {
  showBootError();
});

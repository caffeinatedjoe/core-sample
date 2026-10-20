import { openDatabase } from './db.js';
import { APP_BUILD } from './version.js';
import { mountApp } from './view.js';

const KEYBOARD_THRESHOLD = 80;

function bindViewport() {
  const apply = () => {
    const viewport = window.visualViewport;
    let keyboard = 0;
    if (viewport) {
      // A closed keyboard on iOS standalone still reports a slightly short
      // visual viewport. Only a real keyboard (well past that noise) may lift
      // the frame. The frame's height otherwise stays CSS inset: 0.
      const overlap = window.innerHeight - viewport.height - viewport.offsetTop;
      if (overlap > KEYBOARD_THRESHOLD) keyboard = overlap;
    }
    document.documentElement.style.setProperty('--keyboard-inset', `${Math.round(keyboard)}px`);
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    if (!document.getElementById('layout-debug')?.hidden) paintDebug();
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

function px(value) {
  return `${Math.round(value)}`;
}

function boxLine(el) {
  if (!el || el.hidden) return 'hidden';
  const rect = el.getBoundingClientRect();
  return `top ${px(rect.top)} bottom ${px(rect.bottom)} h ${px(rect.height)}`;
}

function activeScroll() {
  const sheet = document.getElementById('notes-sheet');
  if (sheet && !sheet.hidden) return document.getElementById('notes-list');
  const preview = document.getElementById('preview');
  if (preview && !preview.hidden) return preview;
  return document.getElementById('source');
}

function paintDebug() {
  const panel = document.getElementById('layout-debug');
  if (!panel || panel.hidden) return;
  const viewport = window.visualViewport;
  const probe = document.getElementById('safe-probe');
  const pad = probe ? getComputedStyle(probe) : null;
  const scroll = activeScroll();
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const keyboard = getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset').trim();
  const lines = [
    `innerHeight ${px(window.innerHeight)}`,
    `outerHeight ${px(window.outerHeight)}`,
    `visualViewport.height ${viewport ? px(viewport.height) : 'none'}`,
    `visualViewport.offsetTop ${viewport ? px(viewport.offsetTop) : 'none'}`,
    `screen.height ${px(window.screen.height)}`,
    `devicePixelRatio ${window.devicePixelRatio}`,
    `standalone ${standalone ? 'yes' : 'no'}`,
    `safe-top ${pad ? pad.paddingTop : 'none'}`,
    `safe-right ${pad ? pad.paddingRight : 'none'}`,
    `safe-bottom ${pad ? pad.paddingBottom : 'none'}`,
    `safe-left ${pad ? pad.paddingLeft : 'none'}`,
    `--keyboard-inset ${keyboard || '0px'}`,
    `#app ${boxLine(document.getElementById('app'))}`,
    `#notes-sheet ${boxLine(document.getElementById('notes-sheet'))}`,
    `scroll ${scroll ? scroll.id : 'none'} ${boxLine(scroll)}`,
  ];
  panel.textContent = lines.join('\n');
}

function bindDebug(build) {
  const panel = document.getElementById('layout-debug');
  if (!build || !panel) return;
  const toggle = () => {
    panel.hidden = !panel.hidden;
    paintDebug();
  };
  build.addEventListener('click', toggle);
  build.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });
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
  bindDebug(build);
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

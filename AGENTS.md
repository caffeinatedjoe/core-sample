# Agent rules

Rules for changing this repo.

1. Read `SPEC.md`, `DECISIONS.md`, and `PLAN.md` before changing behavior or architecture.
2. Ship one stage at a time. At the end of a stage, run the tests, update the docs, summarize what changed, and stop. Do not start the next stage in the same change.
3. Vanilla HTML, CSS, and ES modules only. No React, Vue, bundlers, or app frameworks. No new runtime dependency unless `DECISIONS.md` says why a tiny library is the smaller option.
4. Put parsing, toggling, path rules, and storage in `app/js/` modules that do not touch the DOM. Cover them from `test/`. UI code should call those modules, not reimplement them.
5. `npm test` must pass before a stage is done. The runner is `node --test`. The only test dependency is `fake-indexeddb`.
6. Never drop note text. Local save is debounced and also flushed on hide, note switch, and checklist toggle. Do not wait for the network to save. Do not delete or overwrite local notes because a refresh, a failed sync, or a schema upgrade happened.
7. IndexedDB schema changes bump the database version and migrate. Do not wipe the database.
8. The path is the file identity. Use repo-relative POSIX paths. Do not store a second folder tree.
9. The site is served from `/core-sample/`. Asset URLs, the manifest `start_url` and `scope`, and the service worker stay relative. Do not hardcode the subpath. Do not use root-absolute asset paths.
10. The service worker caches the app shell only. Do not cache note bodies, GitHub responses, or tokens. Bump the cache name when a shell file changes.
11. A checklist toggle updates the source in place, keeps selection offsets, and must not focus the editor or open the keyboard.
12. Escape note content that becomes HTML. Do not allow `javascript:` URLs. No analytics, telemetry, or extra third-party requests.
13. No secrets in the repo, logs, URLs, or error text. Do not log note bodies. Do not touch `caffeinatedjoe/zt_vault` until the stage that introduces GitHub sync, and never commit vault contents.
14. Do not force-push.
15. Icons: edit `app/icons/icon.svg`, run `npm run icons`, and commit the PNGs.
16. iPhone is the primary client. Keep safe-area padding, 16px or larger form text, and the `visualViewport` keyboard handling.

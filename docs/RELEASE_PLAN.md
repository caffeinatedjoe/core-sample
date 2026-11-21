# Release plan — Core Sample for strangers

Review of the current app, focused on **security** and **first-run onboarding**. No app code, `APP_BUILD`, or tests were changed for this document.

**Recommendation in one paragraph.** Keep the iPhone-safe device flow and one Cloudflare Worker that Joe operates. Switch the GitHub credential from a classic OAuth App (`repo` on every private repo) to a public **GitHub App** installed on a single vault. Bake the client id and relay URL into the app. First launch should open a local vault with no account; GitHub is an optional second path: one Sign in with GitHub button, then pick or create a repo. Do not wait for GitHub’s SPA/CORS preview (paused). Do not switch to web-flow OAuth until iOS standalone redirect is proven.

---

## 1. Current state

Core Sample is an iPhone-first, local-first Markdown PWA at [https://joecoffey.me/core-sample/](https://joecoffey.me/core-sample/). Shell build `core-sample-shell-v41`. Notes live in IndexedDB (`core-sample`, version 3). GitHub is optional after first launch: a welcome note is seeded with no token (`app/js/notes.js` 155–163, `WELCOME_MD` at 8–19). Syncing a vault today requires the user to create their own OAuth App, deploy `worker/`, and paste client id + relay + `owner/repo` into Settings.

| Piece | Where | What it does today |
| --- | --- | --- |
| Device flow | `app/js/github-device.js` | Scope is hardcoded `repo` (line 5). Polls GitHub through the relay. |
| Token + settings | `app/js/github-store.js` | Token, client id, relay, repo, branch, root, pending device flow, last-4 fingerprint, 20-event auth log. All IndexedDB `meta`. |
| GitHub API | `app/js/github-api.js` | Direct `api.github.com`. Repo is a typed `owner/repo` string (28–32). No repo list, no create. Download is sequential Contents API per `.md` file (638–658). Truncated trees abort (208–214). |
| Settings UI | `app/js/github-ui.js`, `app/index.html` 161–241 | Connect refuses empty client id / relay (351–359). Advanced is open when signed out (`is-bare`, 170–181). Device code + “Copy code & open GitHub”. |
| Relay | `worker/allow.js` | Forwards only `/device/code` and `/oauth/access_token`. Origin allowlist is `https://joecoffey.me` (line 1). No client-id pin, no rate limit, no logging in code. |
| Sync / conflicts | `app/js/github-sync.js`, `conflicts.js`, `conflict-ui.js` | Auto-sync, three-way merge, `force: false` (github-sync.js 169). Disconnect does not erase notes. |
| Backup | `app/js/backup.js` | JSON of note **text** (and folders / recents). Does not export the `images` blob store. |
| Markdown | `app/js/markdown.js` | Escapes HTML; blocks `javascript:` and `data:` URLs (39–49). Tests in `test/markdown.test.js` 52–59. |
| Shell | `app/sw.js`, `app/manifest.json` | Caches app files only. Cross-origin ignored (`sw.js` 161–167). Scope `./`. |
| CI | `.github/workflows/pages.yml` | `npm test` (node `--test` + Playwright WebKit) on PRs; deploys `app/` to Pages on `main`. |
| Legal / versioning | — | No `LICENSE`. No privacy policy or terms. No changelog. `package.json` is `"private": true`, `"version": "0.1.0"`. User-facing version is `APP_BUILD`. |

Local-only use is already viable: open the page, type, export a backup. It is not presented as a first-class path. GitHub is buried in Settings behind three paste fields.

There is **no in-repo live-vault script**. CI never talks to `zt_vault` (AGENTS.md rule 13). Any check Joe runs against the real vault is out of band and should stay that way.

---

## 2. Security findings

Ranked. Each item has a concrete fix. “Verified” means read in this repo or in current GitHub/Cloudflare docs. “Unverified” means not empirically tested from this review.

### Critical

**C1. OAuth scope `repo` is full private-repo access.**  
`GITHUB_SCOPE = 'repo'` (`github-device.js` 3–5). Classic OAuth Apps have no contents-only scope (`DECISIONS.md` 153). A stranger who signs in hands Core Sample read/write on every private repo they own, including ones that are not the vault.  
**Fix:** Register a **GitHub App**. Permissions: Contents read/write, Metadata read, optional Repository creation (account permission — not Administration). Public, installable on selected repositories only. Device-flow `scope` becomes empty or `offline_access` (GitHub Apps do not use OAuth scopes for repo access). The install picker is the least-privilege boundary.

### High

**H1. Tokens never expire and Disconnect does not revoke.**  
OAuth App tokens last until the user revokes them on GitHub. `disconnectGithub` (`github-store.js` 427–445) only clears IndexedDB. A lost phone, an XSS, or a copied backup of the origin’s data keeps a live `repo` token.  
**Fix:** GitHub App user-to-server tokens expire in 8 hours (refresh 6 months) if expiration stays on. Store the refresh token next to the access token. Refresh through the existing relay path (`POST /login/oauth/access_token`). Device-flow refresh does **not** need `client_secret` ([Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)). On Disconnect, tell the user to uninstall the GitHub App (that drops repo access). Link `https://github.com/settings/installations`. Do not put the client secret in the Worker just to call `DELETE /applications/{id}/token` unless Joe later wants server-side revoke.

**H2. XSS on this origin reads the GitHub token.**  
The token is plaintext in IndexedDB (`TOKEN_KEY`, `github-store.js` 4). Any script that runs on `https://joecoffey.me/core-sample/` can call `indexedDB`. There is **no Content-Security-Policy** in `app/index.html`. Markdown is escaped and `javascript:` is blocked (verified by tests), but Live Preview still assigns `innerHTML` from that renderer (`live-editor.js` 70–72, 112, 122, 144). A future render bug is token theft. GitHub Pages cannot set CSP **headers**; a `<meta http-equiv="Content-Security-Policy">` still covers `script-src` / `connect-src`.  
**Fix:** Add a strict meta CSP before any `link`/`script`: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: https:; connect-src 'self' https://api.github.com <relay-origin>; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'`. Keep using `escapeHtml` for every note-derived HTML path; add a test that widgets go through `renderMarkdown` / `mathHTML` only. If Joe puts Cloudflare in front of the host, also send CSP + `frame-ancestors 'none'` as real headers. Unverified: whether `joecoffey.me` is already proxied through Cloudflare.

**H3. Shared relay is under-hardened for strangers.**  
`worker/allow.js` allowlists origin and two paths. It does **not** pin `client_id`, rate-limit, or distinguish abuse from Joe’s own sign-in. CORS is enforced by the browser; a non-browser client with `Origin: https://joecoffey.me` is still forwarded (the tests cover origin rejection for other values, `test/worker-relay.test.js` 51–69). Free-tier cap is **100,000 requests/day per Cloudflare account** ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), checked 13 Nov 2026). Device-flow polling is ~1 req / 5 s for up to 15 minutes. Honest sign-in is cheap; a bot looping `/device/code` can burn the quota (Cloudflare error 1027; sign-in fails; existing tokens and local notes keep working).  
**Fix:** Pin `CLIENT_ID`. Per-IP and per-client-id rate limits (e.g. 30 POSTs / 10 min). Reject unknown `grant_type` once refresh is added (`device_code` and `refresh_token` only). Keep body size cap (already 8192, line 41). Never `console.log` bodies. Cloudflare: disable request-body logging; fail closed on quota. Document that Advanced users may paste their own relay.

### Medium

**M1. No first-run warning that deleting the Home Screen icon wipes notes.**  
Documented for Joe in `README.md` 39 and `DECISIONS.md` 133. Strangers will not read those. iOS treats each added icon as the app; removing it deletes IndexedDB.  
**Fix:** First-run copy plus Settings → About. Export-backup affordance on that screen.

**M2. Initial download has no size/count guard.**  
`collectDownload` walks every `.md` blob sequentially via Contents (`github-api.js` 638–658). A huge or non-Obsidian repo (monorepo, `node_modules` markdown, Linux kernel docs) hammers GitHub’s 5,000 req/hour cap, fills IndexedDB, and can fail mid-way (`truncated` already throws — good). Recursive trees truncate at 100,000 entries / 7 MB ([Git trees API](https://docs.github.com/en/rest/git/trees)).  
**Fix:** After the tree call, show file count + total bytes **before** download. Refuse or warn above a cap (suggest: warn at 500 notes / 50 MB, hard-stop at 5,000 notes or a truncated tree). Prefer Git Data blobs (already used in sync) with a small parallel pool. Detect “this does not look like a vault” (no `.md` at root, thousands of non-md blobs) and say so.

**M3. Backup omits attachment bytes.**  
`backup.js` copies `content` strings only. Binary stubs have `content: ''`; the `images` store is not in the JSON. Local-only users who pasted photos lose them on “erase / new phone / import”.  
**Fix:** Backup format v2 with base64 attachment payloads, or a zip. Keep v1 import.

**M4. `https:` images in notes are third-party requests.**  
Renderer allows `http:`/`https:`/`mailto:` (`markdown.js` 46). A tracking pixel in a note loads. No analytics of our own (good; AGENTS.md 12).  
**Fix:** Document it. Optional later: block remote images unless the user taps. CSP `img-src` should still allow `https:` if remote images stay.

**M5. Device flow is phishable by design.**  
GitHub’s own GitHub App best-practices say not to enable device flow except for CLIs / headless, because an attacker can impersonate the app. We still recommend it for iOS (see §3).  
**Fix:** Always open `https://github.com/login/device` (already pinned, `github-device.js` 21–30). On-screen: “GitHub must show **Core Sample**. If it shows another name, cancel.” Do not enable device flow on a second, unused OAuth app.

### Low

**L1. Copy sign-in log is a primary Settings control.**  
`app/index.html` 167–169. The formatter redacts secrets (`github-store.js` 204–227, `github-redact.js`). Still a support tool, not a consumer control.  
**Fix:** Move under Advanced. Keep redaction tests.

**L2. No IndexedDB quota handling in production paths.**  
`navigator.storage.persist()` is requested (`main.js` 83–87). Quota failures are not mapped to a user sentence except generic save failure.  
**Fix:** Catch `QuotaExceededError`, stop image prefetch, tell the user to export and free space. Never delete notes to recover (`DECISIONS.md` 103).

**L3. Clickjacking / framing.**  
GitHub Pages cannot send `frame-ancestors`. Meta CSP cannot either.  
**Fix:** Cloudflare transform rule `X-Frame-Options: DENY` + `frame-ancestors 'none'` if Joe proxies the host. Unverified whether a frame of the PWA is a real iPhone threat.

---

## 3. Recommended auth and relay

### Options compared

| Option | Least privilege | iPhone PWA | Server secret | Relay still needed? | Notes |
| --- | --- | --- | --- | --- | --- |
| A. Classic OAuth App + device flow + shared relay (today, baked defaults) | Bad (`repo`) | Good | No | Yes (CORS) | Fastest ship. Unacceptable permission for strangers. |
| B. **GitHub App + device flow + shared CORS relay (recommended)** | Good (per-repo install) | Good | No | Yes, tiny | Expiring `ghu_` tokens; refresh **without** secret if the token came from device flow. |
| C. GitHub App + web flow + Worker holds `client_secret` | Good | Risky | Yes | Yes, now an auth server | Redirect into a standalone iOS PWA often lands in Safari, not the Home Screen app. Storage may not be shared. **Unverified on current iOS.** |
| D. GitHub App SPA client + PKCE, no relay | Good | Same iOS redirect risk | No | No, if CORS works | GitHub roadmap [#1153](https://github.com/github/roadmap/issues/1153) (SPA CORS on `/access_token`) is labeled **Paused** (fetched 13 Nov 2026). OAuth Apps still document “CORS pre-flight requests (OPTIONS) are not supported” on the token endpoint. **Not empirically probed from this VM.** |
| E. Fine-grained PAT pasted by the user | Good | Fine | No | No | Worse onboarding than today. Reject. |

PKCE is supported for GitHub OAuth and GitHub Apps as of July 2025. PKCE does **not** add CORS for classic OAuth Apps. Do not assume the browser can `POST https://github.com/login/oauth/access_token`.

**Choose B.** It is the only option that (1) drops `repo`-on-everything, (2) keeps the flow that already works on Joe’s iPhone, (3) needs no client secret in Cloudflare, (4) still lets us bake one client id + one Worker URL.

When GitHub GA’s SPA clients **and** iOS standalone OAuth redirect is proven, revisit D and delete the Worker.

### Target architecture

```
PWA  --device code / token poll / refresh-->  Joe's Worker  -->  github.com
PWA  --repo reads/writes, no token in URL-->  api.github.com
```

Worker stays a CORS shim plus rate limits. It never sees note bodies. It will see access/refresh tokens in GitHub’s JSON the same way it does today; it must not log them (already true in code).

Baked defaults (public, not secrets): `DEFAULT_CLIENT_ID`, `DEFAULT_RELAY`. Settings → Advanced still overrides for power users and for Joe’s current OAuth App during migration.

If the relay is down: local notes work; already-saved GitHub App access tokens work until they expire (~8 h); refresh and new sign-in fail → “Sign in again” / “Couldn’t reach the sign-in service”. Tell the user the vault on the phone is intact.

### Setup Joe does once

**GitHub App** (github.com → Settings → Developer settings → GitHub Apps → New):

1. Name: `Core Sample` (must be unique on GitHub; add a suffix if taken).
2. Homepage: the public app URL (today `https://joecoffey.me/core-sample/`; see Q1).
3. Callback URL: same (unused for device flow; GitHub still wants one).
4. **Expire user authorization tokens:** leave **on**.
5. **Enable Device Flow:** on.
6. Webhook: **off**.
7. Repository permissions: **Contents: Read and write**, **Metadata: Read**.
8. Account permissions: **Repository creation: Read and write** only if Joe wants in-app “Create a private vault” (the app is auto-granted access to repos it creates). Skip this to stay smaller; the user then creates the repo on GitHub and installs on it.
9. Where can it be installed? **Any account**.
10. Copy the **client id** (not the secret, not the App ID). Leave the client secret in GitHub; do not put it in the repo, `wrangler.toml`, or the Worker.
11. Optional: privacy-policy URL (required only for GitHub Marketplace; still do it — see §5).

**Cloudflare Worker** (can keep the existing script, then tighten):

1. Same `wrangler` deploy as `worker/README.md`.
2. Set `ALLOWED_ORIGIN` to the public app origin (and a second origin if Joe adds a dedicated host).
3. Set `CLIENT_ID` to the GitHub App client id; reject other ids.
4. Add rate limits (H3).
5. Dashboard: Workers analytics, daily-request alert well below 100k, no HTTP body logs.
6. Custom Worker route (e.g. `relay.joecoffey.me` or `relay.<app-domain>`) looks less like a throwaway `workers.dev` URL; optional.

**App change (later PR, not this one):** default client id + relay; Sign in with GitHub starts device flow with those defaults; GitHub App install URL `https://github.com/apps/<slug>/installations/new` when the user has no installation; list `GET /user/installations` + installation repos instead of a blank `owner/repo` field.

Joe’s existing personal OAuth App can keep working via Advanced until he reconnects the phone to the GitHub App.

---

## 4. Target onboarding (numbered screens)

Assume iPhone Safari, first visit. Keep GitHub to as few GitHub-hosted pages as GitHub requires (authorize + optional install).

1. **Open.** Editor with `Welcome.md`. No modal over the keyboard. One compact first-run card (dismissible): “Notes stay on this phone. Optional: add to Home Screen, or connect a GitHub vault.” Primary: **Start writing**. Secondary: **Connect GitHub**. Tertiary: **Add to Home Screen** (short Safari instructions).
2. **Start writing** dismisses the card. Local-only. Sync line stays “Not connected to GitHub”. Backup is in Settings.
3. **Connect GitHub** (or Settings → GitHub → Sign in with GitHub). No client id, no relay. Show the user code and one button **Copy code & open GitHub**. Copy: GitHub must list **Core Sample**.
4. **GitHub.com** (Safari): paste code, authorize. If the app is not installed, GitHub’s next page is **install on one repository** (selected repos, not “All repositories”). User returns to Core Sample; the PWA polls and stores the token.
5. **Choose a vault.** List of repos this installation can access (name + private/public). Actions: **Use this repo**, **Create a private vault** (if Repository creation is granted; `POST /user/repos` `{ private: true, auto_init: true }`), or **Install on another repo** (opens the install URL). Default branch filled from the API (`lookupRepository` already does this for a typed name).
6. **Notes folder (optional).** Default: whole repo. A short folder list from the tree (top-level dirs only). Skip = root.
7. **Download preview.** “N Markdown files, ~M MB. Attachments load when you open them.” Confirm. If the phone already has notes: keep alongside / export then replace (existing `github-ui.js` 214–220, 455–538). Progress: “Downloading 12 of 80”.
8. **Done.** Last opened note, sync status in Settings. Advanced (client id, relay, copy sign-in log) stays collapsed.

Error states, same screens: relay down, code expired, GitHub declined, no install, truncated tree, over cap, 401 after install. Each is one sentence + Retry / Cancel. Never a stack trace, token, or relay URL in the headline.

Add-to-Home-Screen is **not** required before writing. After install, a one-time note: removing the icon deletes notes; export first. Icons are snapshotted at add time (`DECISIONS.md` 141); a new icon URL only helps the **next** add.

---

## 5. Phased roadmap

Each row is one (or a tightly stacked pair of) shippable PR. Sizes: **S** one area, **M** several modules + tests, **L** auth/sync surface. Do not combine a stage with the next in the same change (`PLAN.md`).

| Phase | PR | Size | Scope |
| --- | --- | --- | --- |
| 0 | This document | — | Plan only. |
| 1 | First-run local vault | **S** | Screen 1–2. Welcome copy that does not send people to Worker setup. Home Screen / wipe warning. No GitHub API changes. |
| 2 | Baked defaults | **S** | `DEFAULT_CLIENT_ID` / `DEFAULT_RELAY`. Connect works with empty Advanced fields. Advanced override still saved. Tests for “defaults used when inputs blank”. **Needs Joe’s client id + Worker URL in the PR or as build-time constants he pastes.** Can ship on the **current OAuth App** for Joe-only, then swap the id in phase 3. |
| 3 | GitHub App | **L** | New App (Joe’s checklist in §3). Stop sending `scope=repo`. List installations/repos. Install URL when empty. Token meta understands `ghu_` / refresh. Keep device-flow complete/poll races (`github-store.js` 245–325). Migration: Joe reconnects once; strangers never see the old OAuth App. |
| 4 | Vault picker + create | **M** | Screens 5–7. Create private repo if permission granted. Folder picker. Download preview + caps (M2). |
| 5 | Relay hardening | **M** | `CLIENT_ID`, origin list (apex + future host), rate limits, grant_type allowlist, tests in `test/worker-relay.test.js`. Deploy is still Joe (`worker/README.md`). |
| 6 | Token life cycle | **M** | Persist refresh token; refresh before 8 h; 401 → refresh once → else Sign in again. Disconnect copy + installations link. Hide Copy sign-in log. |
| 7 | Client hardening | **M** | Meta CSP. Confirm `connect-src` includes the relay and `api.github.com`. Extra XSS tests on callout/math/embed widgets. Optional Cloudflare headers if the host is proxied. |
| 8 | Backup + data safety | **M** | Backup v2 attachments. Quota error copy. “Doesn’t look like a vault” warning. |
| 9 | Distribution docs | **S–M** | Split README (end user vs develop). `LICENSE` (MIT recommended; CodeMirror is MIT in `app/vendor/codemirror.js`). `PRIVACY.md` + `TERMS.md` (short: notes on device, GitHub sees vault if connected, no analytics, relay sees auth JSON, iOS wipe). `CHANGELOG.md` from `APP_BUILD`. User-facing version still the shell id. |
| 10 | Host / PWA polish | **M** | Only after Q1. If moving origin: treat as a **new install** (IndexedDB is origin-scoped); give Joe an export/import bridge. PWA install page per iOS / Android / desktop. Do not bump icons unless art changes (`AGENTS.md` 15). |

Out of scope for “strangers can use it”: Dataview beyond TASK, desktop two-pane layout, Android-first keyboard work, GitHub Marketplace listing, error telemetry.

---

## 6. Distribution, polish, operations

**Host.** Today: `https://joecoffey.me/core-sample/` (Pages from this repo, path `/core-sample/`). Relative URLs are correct (`DECISIONS.md` 19, `manifest.json` `start_url`/`scope` `./`). A dedicated origin (`coresample.app`, `app.joecoffey.me`) looks more like a product and simplifies CSP/`ALLOWED_ORIGIN`. **Moving origin after people install loses their local notes** unless they export. Decision: pick the public origin **before** inviting strangers (Q1). Joe can keep using the current path until he exports.

**Naming.** Keep **Core Sample**. Tagline: local-first Markdown notes, optional GitHub/Obsidian vault. No extra brand.

**Platforms.**

- **iOS Safari + Add to Home Screen:** primary. Standalone quirks already handled (keyboard, safe area, SW update, icon snapshot). Document: Safari only; Chrome-on-iOS cannot Add to Home Screen the same way.
- **Android Chrome:** should install as a PWA; keyboard/safe-area not the design target. Label “works, not tuned.”
- **Desktop:** usable as a website; single-column phone layout (`app.css` has no wide two-pane breakpoint). Label “works in a browser.”

**Privacy / terms.** Marketplace is the only GitHub surface that **requires** a privacy URL. Write one anyway: what is stored (notes, token, refresh token on device), what GitHub gets, what the Worker sees (device/token JSON, not notes), no telemetry, how to disconnect and uninstall, how to delete local data. Terms: provided as-is, user owns their vault, no warranty of GitHub uptime.

**LICENSE.** Add MIT (or Apache-2.0 if Joe prefers). Include CodeMirror’s MIT notice. `private: true` in `package.json` can stay until the GitHub App is public.

**Telemetry / errors.** None. Do not add Sentry. Support path: Advanced → copy redacted sign-in log.

**A11y.** Many controls already have `aria-label` and 44pt hits. Gaps: first-run card, repo picker, VoiceOver on Live Preview widgets. Dynamic Type / 16px floor is policy (`DECISIONS.md` 176). Contrast of conflict colors is documented (`docs/conflict-ui.md` 21); not re-measured here.

**Large vaults.** Live Preview virtualizes (`DECISIONS.md` 175). Initial download and a full task-index pass will dominate. Caps in phase 4 matter more than editor FPS.

**CI / monitoring.**

- Gate: `npm test` on every PR (`pages.yml`). Keep it mock-only.
- Joe’s live vault: manual, on a phone he already trusts; never in CI.
- Relay: Cloudflare Workers analytics (requests, errors, CPU). Alert at ~50k req/day. No body logs. Optional `GET /health` that does not call GitHub (today GET is 404).
- App: Settings → About build id; no crash reporter.

---

## 7. Open decisions for Joe

1. **Public URL before strangers arrive?** Stay on `joecoffey.me/core-sample`, move to a subdomain (`app.joecoffey.me`), or buy a dedicated domain? Origin change later wipes on-device data.
2. **GitHub App name** if `Core Sample` is taken?
3. **Repository creation permission?** In-app “create a private vault” vs user creates the repo on GitHub and installs on it (one extra GitHub page, fewer permissions).
4. **Ship phase 2 on the existing OAuth App** (Joe-only, still `repo`) while the GitHub App is registered, or wait and ship defaults only with the GitHub App?
5. **Cloudflare:** keep `*.workers.dev` or put the relay on a hostname you control? Is `joecoffey.me` already on Cloudflare (needed for real security headers)?
6. **LICENSE** MIT vs Apache-2.0 vs something else?
7. **Who is v1 for?** Anyone with a GitHub account, or a small invite list first (GitHub App can start private to Joe’s account, then flip to Any account)?
8. **Android / desktop:** “unsupported but works” in the README, or silent?

---

## Unverified

- Browser CORS against `https://github.com/login/oauth/access_token` was **not** probed from this VM; GitHub’s OAuth-app docs still say OPTIONS is unsupported; SPA GitHub App CORS is a **paused** preview.
- iOS standalone OAuth **redirect** (web flow landing in the Home Screen app vs Safari, and whether IndexedDB is shared) was not tested here. Device flow is what the current app uses on Joe’s phone.
- Whether `joecoffey.me` is Cloudflare-proxied, and the live Worker URL / request volume.
- Real GitHub App client-id availability and whether “Core Sample” is a free app name.
- Android Chrome install, desktop keyboard, and a11y contrast were not re-run.
- Empirical Workers 1027 behavior for this account.
)

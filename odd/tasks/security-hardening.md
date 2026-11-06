# Feature: security-hardening (Pañol 2.1.0)

## Objective
Fix the defects found in the 2026-11-06 audit (static review + headless E2E) and ship Pañol 2.1.0.

## Problem
The app works for normal use, but the `.txt` import path is unauthenticated, unvalidated and
renders imported ids/numbers without escaping. A crafted or malformed file can take over the
admin account, run script (stored XSS), wipe all data, or brick the app. The shared file also
exposes weak PIN hashes, and "Combinar" silently overwrites newer local data.

## Scope
- In: `index.html`, `sw.js`, `LEEME.md`, `manifest.webmanifest` (only if needed), new `tests/`,
  `.gitattributes`, `CLAUDE.md` (project), this document.
- Out: visual redesign, new features, build tools or runtime dependencies.

## Constraints
- Static PWA, no build, no runtime dependencies. Keep existing data readable (backward
  compatible with 2.0.0 `.txt` files and IndexedDB contents, including legacy PIN hashes).
- Tests use Node built-ins only (`node --test`, Node 22+ WebSocket + CDP to Chrome/Edge).
- Commits: Conventional Commits, no AI attribution, on branch `fix/security-hardening`.

## Delivery strategy
`ask-on-risk`. Forecast exceeds ~400 authored lines mostly due to the E2E suite; tests travel
with their behavior. Single PR-sized branch requested by the user; chain decision deferred.

## Tasks
- [x] T1 Import gate and schema validation: import requires a logged-in admin (except first run
      with no users), in UI, auth view and `launchQueue`; `parseDataText` rejects non-object
      `data`; per-collection schema validation for Replace and Merge (ids via `validId`, reject
      `__proto__`/`constructor`/`prototype`, typed fields, finite numbers); size limit; replace
      never leaves zero admins.
      Evidence: RED on baseline (`node tests/e2e/run.mjs t1`: 4 of 5 failed — xss `__xss=1` on
      `#tecnicos`, `data:{}` wipe, logged-out button present); GREEN after fix (5/5). Also
      `t6` 4/4 and legacy 2.0.0 fixture imports under strict validation. Route: delegated writer. Commit `09a86d2`.
- [x] T2 Output hardening: escape every interpolated id/number in HTML and attributes; coerce
      `qty` with `Number()` in `derive`; CSP meta in `index.html`; SRI + `crossOrigin` on cdnjs
      xlsx/jspdf.
      Evidence: 102 attribute interpolations wrapped in `esc()`; CSP uses the inline script
      sha256 (kept in sync by `node tests/csp-hash.mjs`, no 'unsafe-inline' for scripts); SRI
      sha512 computed from the downloaded cdnjs files. RED on baseline (`t2`: CSP and SRI specs
      failed); GREEN 3/3 with no CSP violations (Excel/PDF exports run); `t1` 5/5, `t6` 4/4.
- [ ] T3 Merge semantics: `put`/`patch` stamp `updatedAt`; strict newer-wins; tombstones for
      deletions so merge does not resurrect; flag negative pools in `integrity()`.
- [ ] T4 PIN hardening: PBKDF2-SHA-256 (high iterations) with transparent upgrade of legacy
      hashes on successful login; progressive lockout after failed attempts; LEEME note.
- [ ] T5 Robustness and PWA: SW caches navigations only when `r.ok && !r.redirected` inside
      `waitUntil`; flush pending writes on `pagehide`/`visibilitychange`; protect pending writes
      from BroadcastChannel reload; catch handler rejections; bump `VERSION` to `panol-v2.1.0`.
- [ ] T6 Regression suite and docs: `tests/e2e/run.mjs` (no deps) covering audit flows and the
      failing cases (XSS via ids, `data:[]`, wrong-shape replace, logged-out import); project
      `CLAUDE.md`; `.gitattributes`; LEEME update.
- [ ] T7 Close: `versiones/panol v2.1.0`, workspace index update, GitHub repo (user-authorized).

## Route declaration
- Setup (backup `versiones/panol v2.0.0`, `git init`, baseline commit 11296b1): inline.
- T1–T6: delegated to one writer (2+ non-trivial files; preparation reading of a 1673-line file).
- T7: parent, inline.

## Acceptance criteria
- All previously failing E2E cases pass; all previously passing flows still pass.
- No console/page errors in the suite. `node --check` on the inline script passes.
- A 2.0.0 export imports correctly into 2.1.0; legacy PIN still logs in.

## Applicable checks
- `node tests/e2e/run.mjs` (headless Edge/Chrome).
- Inline script syntax check.

## Progress
- 2026-11-06: baseline committed (11296b1), branch `fix/security-hardening`, backup
  `versiones/panol v2.0.0` created.

- 2026-11-06: regression suite written first (`tests/e2e`, raw CDP, no deps); baseline RED:
  16 of 23 specs failed. T1 done.
- 2026-11-06: T2 done.

## Next step
T3.

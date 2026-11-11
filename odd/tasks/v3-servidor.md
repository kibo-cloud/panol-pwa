# Feature: v3-servidor (Pañol 3.0)

## Objective
Turn Pañol 2.1 (static PWA, IndexedDB + `.txt`) into a multi-user web system with a server
(Node 22 + Fastify + PostgreSQL 16) and deliver the 3.0 scope in `docs/PEDIDO-v3.md`, without
losing any 2.1 feature or security protection.

## Problem
Data lives on each phone and is shared by `.txt` files: no single source of truth, no
concurrent use, no server-side permissions. Fixed turnos do not match rotating plantillas, and
the old Excel workflow (counts, cleaning, purchases, audits) is not covered.

## Scope
- In: everything in `docs/PEDIDO-v3.md` §2, in the stage order of §5.
- Out: `main` (only fixes), `privado/` (never committed or used for fixtures), VPS deploy
  (user will contract it later; deployment files are written and validated in CI only).

## Constraints
- Branches: `v3-servidor` (integration); one branch and one PR per stage, `v3/etapa-N-<tema>`.
  CI green before review. Work-unit commits on the stage branch; squash merge gives one commit
  per stage on `v3-servidor`.
- Stack and rules: project `CLAUDE.md` (approved 2026-11-07).
- Timezone `America/Argentina/Buenos_Aires` (server and DB). 4 controls per month (week
  `w = min(4, ceil(day/7))`), as in 2.1.
- Local DB: `embedded-postgres` pinned to the Compose `postgres` image version; data in
  `.pgdata/`; `npm run db:reset` seeds invented data.
- Tests: `node --test` (unit), integration against PostgreSQL (embedded locally, `postgres:16`
  service in CI), E2E with the existing CDP runner.
- No e-mail: admins reset passwords; reset forces a change on next login.

## Decisions (user, 2026-11-07)
- Vite: yes, no framework, CSP `script-src 'self'`, xlsx/jspdf self-hosted with SRI.
- Cleaning: tools and box cleaning, recorded per control (stage 4).
- Temporary coverage with return date: yes (stage 2).
- Line on missing/broken: optional, never blocks a control (stage 4).
- Purchases: estimated cost and supplier optional; any Gerencia user decides, one approval is
  enough; one open request per assignment/unit, later controls link to it; a rejected request
  keeps the alert visible as "compra rechazada" with its reason (stage 7).
- Gerencia role: decides purchases; read-only access to tool sheet, control history, alerts,
  stock per tech and reports; by default no controls, deliveries or admin (configurable).
- Supervisor changes of a plantilla are recorded with date and actor, like rotations (stage 2).
- Import: empty date only in optional fields (stored null); empty required date is a report
  error. `main` unchanged.
- Backups: daily `pg_dump` with rotation + off-VPS copy + tested restore script.
- VPS provider/domain: pending (not a priority). Test environment cancelled until the VPS.
- Logo: pending, loaded later from Administración › Empresa.

## Assumptions (to confirm in the stage 1 PR)
- Default permissions for the new roles: supervisor = same as responsable plus
  `shift_change`; gerencia = `reports_export` only (purchase permission arrives in stage 7).
- Off-VPS backup: `rclone` to an S3-compatible bucket (proposal: Backblaze B2 or Cloudflare
  R2), configured only through `.env`; disabled when not configured.
- Migrated v2 users get a username derived from their name (lowercase, no accents, unique
  suffix); the admin can edit it.

## Delivery strategy
`auto-chain`, chain strategy `feature-branch-chain` (user-defined: one PR per stage against
`v3-servidor`). Forecast far above ~400 authored lines per stage; each stage is one PR.

## Stages (PEDIDO §5)
1. Servidor, usuarios y migración desde el `.txt` — done (PR #1)
2. Plantillas, movimiento de técnicos y líneas — done (PR #2)
3. Especialidad, kit base y orden — done (PR #3)
4. Conteo por cantidad y limpieza — done (PR #4)
5. Eliminar y anular — done (PR #5)
6. Novedades — done (PR #6)
7. Gerencia — done (PR #7)
8. Existencia por técnico y alertas — implemented, in review (`v3/etapa-8-existencia`)
9. Importador del Excel
10. Impresión de auditoría

## Stage 1 tasks
- [x] E1.T0 Branch setup and docs: `chore` commit of `.gitignore` + `docs/` on `main`
      (`ed3dedb`, `privado/` verified absent); merged `fix/security-hardening` deleted;
      branches `v3-servidor` and `v3/etapa-1-servidor`; approved project `CLAUDE.md`; design
      guide §9 updated for v3; this document. Route: parent inline (mechanical docs).
- [x] E1.T1 Server scaffold: `package.json` (pinned deps), Fastify app with config from
      `.env` (`.env.example`), TZ, `/api/health`, migration runner, `embedded-postgres` dev/test
      harness, `npm run db:reset` with invented seed, `.pgdata/` ignored, `node --test` setup.
      Commits `0326e6d` (+ `aad3363` db:stop script). Route: delegated writer.
      Deps pinned (>= 2 weeks old): fastify 5.12.7, @fastify/cookie 11.1.3, pg 8.23.1,
      argon2 0.45.1, embedded-postgres 16.14.0-beta.17 -> PostgreSQL 16.14, recorded in
      `server/pg-version.json` (Compose image `postgres:16.14`).
      Evidence: `npm test` 5/5; `npm run test:db` 4/4 (health, 404, DB session TZ, runner
      order/idempotence/rollback/checksum); `npm run db:start` + `db:reset` ok; live
      `GET /api/health` -> `{"ok":true,"db":true}`.
- [x] E1.T2 Schema and domain: migration 001 with the 2.1-equivalent model (users, role
      permissions, sessions, login attempts, techs, shift list and shift changes, categories,
      tools, units, assignments, movements + transfers with append-only trigger, controls +
      items with unique original per tech/period and finalized-immutable trigger, alert
      resolutions, audit log, settings). Pure domain ported from 2.1 (pools from transfers,
      periods, effective control, alerts) with unit tests.
      Commit `53772d4`. Route: delegated writer. Test-first: RED observed (6 files failing on
      missing modules), then GREEN. Evidence: `npm test` 41/41; `npm run test:db` 14/14
      (migrations from empty, seed coherent with the ledger, append-only movements/transfers/
      audit incl. TRUNCATE, finalized control + items immutable, unique original control,
      id/pool/legajo/unit-code constraints, one reception per pending return, DB TZ).
- [x] E1.T3 Auth and users: argon2id, httpOnly session cookie with "Mantener la sesión",
      CSRF token, server-side progressive lockout (5 failures, 30 s doubling, max 15 min),
      admin creates/deactivates/resets users (forced change), roles admin/gerencia/supervisor/
      responsable/consulta with configurable permissions, permission check on every endpoint.
      Commit `9e78e57`. Route: delegated writer. Evidence: `npm test` 45/45; `npm run test:db`
      30/30 (16 auth: login ok/generic errors, strict schemas, lockout 30 s -> 60 s -> max
      900 s persisted across app restart, unknown users lock too, CSRF token + Origin +
      Sec-Fetch-Site, forced change flow, admin-only users with If-Match 409, last-admin and
      self-deactivate guards, permission defaults + overrides, idle/absolute expiry);
      `node tests/e2e/run.mjs t4` 3/3 (2.1 suite untouched).
- [x] E1.T4 API for every 2.1 operation: CRUD (techs, tools, units, categories, turnos),
      movements with server-side stock validation, controls (draft, finalize, correction),
      alert resolutions, audit, permissions; schema validation; `version` + `If-Match` -> 409;
      SSE `/api/events`; audit on every important action; idempotency keys for drafts.
      Commits `745c437` (catalog, read models, reports, SSE, migration 002) and `68a522a`
      (movements, controls, alerts, demo). Route: delegated writer.
      Endpoints: `POST/PATCH /api/techs`, `POST /api/techs/:id/shift-change`,
      `POST/PATCH/DELETE /api/shifts`, `POST/PATCH/DELETE /api/categories`,
      `POST/PATCH /api/tools`, `PATCH /api/units/:id`, `GET /api/state|inventory|alerts|
      integrity|reports|controls|controls/:id`, `GET /api/audit` (admin, cursor),
      `POST /api/movements`, `POST /api/controls`, `PATCH /api/controls/:id`,
      `POST /api/controls/:id/finalize`, `POST|DELETE /api/alerts/:key/resolution`,
      `POST|DELETE /api/demo`, `GET /api/events` (SSE via LISTEN/NOTIFY, ping 25 s).
      Evidence: `npm test` 52/52 (new: derive/report/integrity/catalog rules); `npm run
      test:db` 55/55 (new files catalog-api, movements-api, controls-api, reads-api:
      permissions for consulta/gerencia/responsable/supervisor, schema rejections, 428/409
      with `current`, ETag, oversell race with the tool row held from another connection ->
      [201, 422] and [201, 422, 422], idempotent replay incl. concurrent same key and
      mismatch 422, finalize immutability, unique original, correction flow, report numbers
      on an API-built fixture, SSE event after a write, demo load/clear). Race test RED
      observed with the `FOR UPDATE` removed (`[201, 201]`), GREEN with it. Domain unit tests
      were written with the code (no RED run). `npm run db:reset` + `npm start` + curl login
      (cookie + `X-CSRF-Token`) -> `GET /api/state` 200, `POST /api/techs` 201 with `ETag`;
      server and `db:stop` stopped. `node tests/e2e/run.mjs t6` 4/4 (2.1 suite untouched).
- [x] E1.V1 Security corrections from the independent review of E1.T1-E1.T4 (PASS with
      issues). Route: delegated writer. Test-first: `server/test/integration/security.test.js`
      (9 tests) + unit `config`, `secret-file`; RED observed (8 integration tests failing: item
      INSERT accepted on a control being finalized, draft tech/period/correction changes
      accepted, 9 verifications on 12 parallel bad logins, app connected as superuser, old
      session alive after login, session id unchanged after password change, user routes 200
      without If-Match, two parallel admin demotions both 200; unit files failing on missing
      `requireDevEnvironment` / `withSecretFile`), then GREEN. Fixes: migration 003
      (`control_items_guard` reads the parent with `FOR SHARE`; `controls_guard` forbids
      changing tech, period, correction/supersedes on a draft; role `panol_app` with
      SELECT/INSERT/UPDATE/DELETE only, no UPDATE/DELETE/TRUNCATE on `movements`,
      `movement_transfers`, `audit_log`, no access to `schema_migrations`; demo ledger clear via
      `demo_clear_ledger()` SECURITY DEFINER limited to demo rows); login and current-password
      checks reserve the attempt (`login_locks` row `FOR UPDATE` in the same transaction as the
      verification and the failure count); last-admin checks serialized with a constant
      advisory xact lock (role change, deactivate, reset); config defaults to production
      (requires `APP_ORIGIN`, `DATABASE_URL`; unknown `NODE_ENV` refused; seed, `db:reset`,
      `db:start` refuse outside development/test), test scripts use
      `--env-file=server/test/test.env`; app/owner split (`DATABASE_URL` = `panol_app`,
      `MIGRATION_DATABASE_URL` = owner; `main.js` migrates + provisions with the owner and
      refuses to serve as superuser/owner; harness and dev scripts updated); login deletes the
      session behind the incoming cookie, password change closes all sessions and returns a new
      cookie + CSRF token; `initdb` password file in `mkdtemp` dir, `wx` + 0600, removed after
      use; user PATCH/deactivate/reactivate/reset-password require If-Match (428/409).
      Evidence: `npm test` 60/60; `npm run test:db` 64/64; `npm run db:reset` without
      `NODE_ENV` refused, with `NODE_ENV=development` ok (migration 003 applied).
- [x] E1.T5 `.txt` v2 importer and export: admin-only; same validation as 2.1 plus the empty
      date rule; `data.deleted` applied; PIN users migrated (PIN works once as temporary
      password, then forced change); import report before confirming; *Descargar .txt*.
      Route: delegated writer. Code: `server/src/importers/txt-v2/{validate,plan}.js` (pure),
      `adapters/pg/txt-repo.js`, `application/txt-import.js`, `adapters/http/txt-routes.js`,
      `application/legacy-pin.js`, migration 004 (`imported` on movements, controls, audit).
      Endpoints: `POST /api/import/txt?mode=merge|replace&dryRun=1` (text/plain body, 20 MB
      text like 2.1) -> report (counts per collection, ids to create/update/delete, errors
      with collection/id/field, conflicts, assumptions such as generated usernames, new users
      with PIN kind, `token`); same body with `&token=` applies in one SERIALIZABLE
      transaction, refused (409) if the plan changed since the report, 422 while errors
      exist; `GET /api/export/txt` (admin) -> 2.1-shaped `.txt` v2 with `deleted: {}` and users
      without any credential field. Audit `import_txt` (summary) and `export_txt`.
      Rules: version 2 only; merge = 2.1 `mergeInto` (newer stamp wins, tie keeps server,
      newer tombstone deletes, stamps > 1 day ahead clamped), but movements/audit are append
      only and finalized controls immutable (differences are reported conflicts); replace only
      on a server without movements/controls, file must have an active admin, importer's own
      user kept, other server users not in the file deleted; referential and uniqueness checks
      on the final state (dangling shift/category -> null with an assumption, legajo/unit
      code/original control/reception duplicates -> errors); empty optional date -> NULL,
      empty required date (movement/audit/alert/shift-change `at`, `finishedAt` of a finalized
      control) -> report error. PIN users: username from the name (lowercase, no accents,
      non-alnum -> `.`, numeric suffix), `legacy_salt`/`legacy_pin_hash`, no password hash,
      `must_change_password`; login verifies pbkdf2$/sha256:/fnv: in constant time under the
      same lockout, change-password accepts the PIN and clears the legacy fields.
      Fixture: `server/test/fixtures/v21.js` (invented 2.1 export, pbkdf2 PINs; writes
      `v21-export.txt`). Tests written with the code (no RED run). Evidence: `npm test` 63/63
      (new: legacy PIN algorithms, username derivation, reader); `npm run test:db` 83/83 (new
      `txt-import.test.js`, 19: admin-only 403/401, versions 1/3/'2'/missing, proto key,
      garbage, JSON body 415, 413 over 20 MB, replace dry-run counts without writes, token
      required/stale, no-admin refusal, replace apply (ids, original `at`, transfers, empty
      optional dates NULL, controls imported, shifts, permissions, users with legacy PIN,
      audit), replace refused with ledger, pbkdf2 login + forced change + legacy cleared,
      lockout on PIN login, 2.0.0 fixture merge with sha256/fnv logins, merge newer/tie/older,
      tombstones newer/older + ledger/finalized conflicts, movement/finalized control
      conflicts, future clamp, required empty date errors + confirm 422, export without
      credentials, export -> dry-run = 0 changes); live: `db:reset` + `node
      server/src/main.js` (as `panol_app`) + curl login 200, `GET /api/state` 200, dry-run of
      `legacy-2.0.0.txt` 200 (5 errors: unit codes already in the dev seed, as expected) and
      of `v21-export.txt` 200 (`canApply`, 22 changes), `GET /api/export/txt` 200; server
      and `db:stop` stopped. `node tests/e2e/run.mjs t3` 4/4 (2.1 suite untouched).
- [x] E1.T6 Frontend on Vite: split `index.html` into feature modules, API client replaces
      `S`/`put`/`patch`/`del`, login with user + password + "Mantener la sesión", forced
      password change, live updates via SSE, conflict notice on 409, offline banner + local
      draft of the control in progress resent on reconnect, CSP `script-src 'self'`, xlsx and
      jspdf self-hosted with SRI, service worker updated. Same views and design.
      Commits `33c02ae` (toolchain, client, store, shared UI), `eea6f47` (feature views),
      `021f949` (server static + headers). Route: delegated writer. Code: `web/` (Vite root; `src/api` only data access, `src/state`
      store + pure 2.1 derive + drafts, `src/ui` shared components/router/modal, 13
      `src/features/*`), `vite.config.js` + `web/scripts/vendor-plugin.js` (copies xlsx 0.18.5 /
      jspdf 2.5.1 to `vendor/`, sha384 into `virtual:panol-vendor`), `web/scripts/dev.mjs`
      (`npm run dev`), `server/src/adapters/http/web-routes.js` (static + SPA fallback + headers).
      Deps (exact): @fastify/static 10.1.7; dev: vite 7.3.7, xlsx 0.18.5, jspdf 2.5.1,
      @fontsource/inter 5.2.8 (npm builds of xlsx/jspdf have the same sha512 as the 2.1 cdnjs SRI).
      Tests written with the code (no RED run). Evidence: `npm test` 88/88 (new web: api client
      headers/error kinds/offline guard, `esc`, router, draft queue, constants parity with the
      server); `npm run test:db` 89/89 (new `web.test.js`: exact CSP, nosniff, Referrer-Policy,
      HSTS only in production, immutable cache for assets/vendor, no-cache index/sw/manifest,
      SPA fallback, /api and missing files 404); `npm run build` -> `web/dist/index.html` has
      only `<script type="module" src>` + `<link rel="stylesheet">` (0 inline script/style/
      handlers); live CDP smoke on `db:reset` + build served by Fastify, 67/67: login (wrong
      password message), 17 routes + 4 admin tabs at 1280 and 390 without overflow, draft saved
      then finalized, entrega, xlsx/pdf/csv exports, SSE conflict notice + 409 refusal + "Mantener
      mis cambios", offline banner on server stop, draft kept in IndexedDB `panol-drafts` and
      resent on reconnect, other writes refused offline, logout, forced password change for a new
      gerencia user, lockout countdown, 0 CSP violations, 0 console errors; `npm run dev` proxied
      `/api` login + SSE; server and `db:stop` stopped. `node tests/e2e/run.mjs t6` 4/4 (2.1
      suite untouched).
- [x] E1.T7 E2E: runner starts the server on a seeded embedded DB; the 30 existing specs
      adapted; new specs for login, lockout, forced password change, `.txt` migration,
      conflict 409, offline draft.
      Commits `be1117d` (CSV formula guard), `375b9e2` (draft sent on route leave), `cdd0a4a`
      (runner + specs), `452c313` (2.1 root app retired). Route: delegated writer.
      Runner (`tests/e2e/server.mjs`, no new deps): `vite build` when `web/dist` is older than
      the sources; PostgreSQL via the integration harness (embedded temp cluster, or
      `TEST_DATABASE_URL`); template DB = migrations + `panol_app` + invented users
      (`tests/e2e/seed.mjs`, one per role, `panol-e2e-1234`); each spec gets
      `CREATE DATABASE ... TEMPLATE` (TRUNCATE is blocked by the append-only triggers), a new
      Fastify app as `panol_app` and a fresh browser context, behind a fixed-port proxy whose
      `offline` flag drops every connection (SSE included). Specs read state through the API
      from the page or the owner pool (`srv.db`): the v3 app has no globals. `npm run test:e2e`.
      Spec mapping (35 = 26 adapted + 9 new; 4 retired with 2.1 device storage):
      t1 import (5): malformed/oversized/proto files and XSS ids/turnos/numbers rejected by the
      server report with data unchanged; imported markup escaped on every route; replace without
      active admin refused; logged-out and non-admin cannot import (no UI, forged click, API
      401/403; replaces the 2.1 launch handler). t2 output (3): CSP header exact on pages/assets/
      API, no inline script/style (replaces the meta hash; `tests/csp-hash.mjs` retired); typed
      markup shown as text; xlsx/pdf from `/vendor/` with sha384 SRI (no cdnjs, no online skip).
      t3 merge (4): version/updatedAt bump + stale 409 + 428 (replaces client stamps/tombstones);
      Combinar newer wins/tie keeps server/file tombstone deletes/tombstoned record not created/
      future clamp; replace restores an export (needs a second admin in the file) and re-import
      = 0 changes; integrity flags a negative pool inserted through the owner connection.
      t4 credentials (3): argon2id + generic error; 5 failures lock, button disabled, 429, persists
      after reload in `login_locks`; 2.0.0 import, sha256/fnv PIN once then forced change.
      t5 PWA (6): SW cache `panol-v3.0.0-dev` without /api or error pages, offline shell, recovery;
      offline banner + draft in IndexedDB across reload, resent on reconnect; SSE refresh keeps the
      typed form (replaces BroadcastChannel); leaving the checklist saves the draft (replaces
      pagehide flush; found the bug fixed in `375b9e2`); change survives immediate reload; failed
      action shows a toast/dialog error (replaces the injected rejecting handler).
      t6 flows (4): boot = login screen (no first-run setup in v3); demo routes at 1280/390 + admin
      tabs + integrity; tool/tech/entrega/control/reposición persist; consulta and gerencia
      read-only (UI, forged clicks, API 403). t7 verifier (4): maxlength = LIM + server 400; ISO
      dates + future clamp on import; empty optional date -> NULL, empty required date -> report
      error; 8 clicks on Ingresar -> 1 attempt. Retired: unsaved localStorage copy, replace
      tombstones in the device, quarantine of stored records. t8 new (6): "Mantener la sesión"
      (persistent httpOnly 30-day cookie vs session cookie), admin reset -> forced change, SSE
      between two sessions, 409 notice + no overwrite + explicit keep, 2.0.0 replace migration end
      to end (counts, routes, users), CSV formulas neutralized.
      CSV fix test-first: `web/test/csv.test.js` RED (`'=1+1'` expected), then GREEN; the route
      leave bug was found RED by t5 (draft never reached the server) then GREEN.
      Evidence: `npm test` 91/91; `npm run test:db` 89/89; `npm run build` ok;
      `npm run test:e2e` 35 passed, 0 failed, 0 skipped (257 s, Edge headless, embedded PG 16.14).
      Root `manifest.webmanifest` and `icons/*` removed after checking identical git blob hashes
      with `web/public/`; `tests/e2e/fixtures/` kept (`make-fixtures.mjs` now uses
      `startStaticServer` for the 2.0.0 baseline).
- [x] E1.T8 Deploy and CI: `Dockerfile`, `docker-compose.yml` (app, `postgres:16.x`, caddy
      with automatic HTTPS, backup with rotation + optional rclone off-VPS copy),
      restore script tested in CI, `LEEME.md` install/update/restore; GitHub Actions on push
      and PR to `v3-servidor` and `v3/**`: unit, integration (`postgres:16`), compose build +
      up + `/api/health` smoke + down, E2E.
      Commits `b0de8fe` (`npm run admin:create`), `5fd23b0` (image, Compose, Caddy, backups),
      `95f8a2f` (CI workflow), `51457a9` (LEEME v3). Route: delegated writer.
      Image `node:22.22-alpine` (Docker Hub tag checked; 22.23 is newer), multi-stage, `npm ci`,
      `vite build`, `npm prune --omit=dev`, user `node`, healthcheck on `/api/health`. Compose:
      `postgres:16.14` (= `server/pg-version.json`, enforced by `server/test/unit/
      deploy-versions.test.js` together with the backup image `postgres:16.14-alpine`, the CI
      services and `embedded-postgres`), TZ/PGTZ Buenos Aires; app with two credentials
      (`DATABASE_URL` = `panol_app`/`APP_DB_PASSWORD`, `MIGRATION_DATABASE_URL` = owner
      `POSTGRES_USER`/`POSTGRES_PASSWORD`), `TRUST_PROXY=true`, `APP_ORIGIN=https://${DOMAIN}`;
      `caddy:2.11.8-alpine` (`Caddyfile`: automatic HTTPS, HSTS, `flush_interval -1`, no
      compression on `/api/events`); `backup` image (pg 16.14 tools + rclone): daily at
      `BACKUP_HOUR`, `pg_dump -Fc` verified with `pg_restore --list`, rotation 7 daily / 4 weekly
      (Sunday) / 6 monthly (day 1), first run seeds weekly/monthly; off-VPS `rclone copy` when
      `.env.offsite` defines `BACKUP_REMOTE` + `RCLONE_CONFIG_OFFSITE_*` (R2 and B2 examples in
      LEEME), disabled without that file. `scripts/backup/restore.sh [--yes] <dump>` (volume path
      or local file; without `--yes` only explains): stop app, drop/recreate DB, `pg_restore`,
      start app (migrates + provisions `panol_app`), wait for health. `scripts/backup/
      ci-test.sh`: insert row -> backup -> delete -> restore refused without `--yes` -> restore ->
      row back, readable as `panol_app`, migrations present. `docker-compose.ci.yml` publishes
      the app on 127.0.0.1:3000 (Caddy serves `localhost` with its internal CA).
      CI (`.github/workflows/ci.yml`, `contents: read`, actions checkout/setup-node/
      upload-artifact @v4, Node 22): unit (+ build), integration (service `postgres:16.14`,
      `TEST_DATABASE_URL`), compose (CI `.env` with random hex passwords, build, up, health direct
      and via Caddy HTTPS, HSTS + CSP headers, HTTP -> HTTPS 308, credentials check,
      `admin:create`, backup/restore test, logs on failure, `down -v` always), e2e (runner Chrome
      `/usr/bin/google-chrome`, `PANOL_BROWSER_ARGS=--no-sandbox`, artifact `tests/e2e/out/` on
      failure). `npm run admin:create -- <user> "<name>"` (`server/scripts/admin-create.js`):
      admin with one-time temporary password, forced change, audited; integration test (2).
      Evidence: `npm test` 96/96 (new deploy-versions 5; drift check RED with the compose tag set
      to 16.13, then GREEN); `npm run test:db` 91/91 locally and 91/91 with `TEST_DATABASE_URL`
      on a separate cluster (CI path); `npm run test:e2e` 35/35 locally (embedded) and 35/35 via
      `TEST_DATABASE_URL` (242 s); `sh -n` OK on the 5 shell scripts (LF, mode 100755);
      `node --check` OK; compose + workflow YAML parsed and checked structurally by a throwaway
      Node script (services, images, two credentials, triggers, permissions, steps uses xor run,
      pinned actions; negative check fails on a broken indent). Docker is not available on the
      dev machine: the image build, Compose, Caddy, backup/restore and the CI workflow are
      validated only syntactically until the first CI run (pending).
      `.env.example` could not be read in this session (deny rule), so it was not updated: the
      deploy variables are documented in `docker-compose.yml` comments and `LEEME.md` §2.3/§4.4
      (`DOMAIN`, `ACME_EMAIL`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
      `APP_DB_PASSWORD`, `BACKUP_HOUR`, `KEEP_DAILY`, `KEEP_WEEKLY`, `KEEP_MONTHLY`; `.env.offsite`:
      `BACKUP_REMOTE`, `RCLONE_CONFIG_OFFSITE_*`).
- [x] E1.T9 Close stage 1: CI green, PR `v3/etapa-1-servidor` -> `v3-servidor` with what was
      done, how to test and test results.
      Evidence: branches pushed (history scanned: no `privado/`, `.pgdata/` or real `.env`).
      CI fixes found only on the runner, each verified locally before pushing:
      `COLLATE "C"` in an import test (Debian locale sorts `u-imp` last); per-spec E2E timeout
      (a hung CDP call stalled the job 30 min); browser stderr and 30 s wait on launch; root
      cause of the 2 failing SW specs: the runner inherits `NODE_ENV=test`, so its `vite build`
      produced `PROD=false` and the app never registered the worker (now forced to
      `production`; the app also registers when `load` already fired). Local with forced
      rebuild: e2e 35/35, unit 96/96. CI run 42460525210: unit, integration, compose (build,
      smoke, backup/restore) and E2E (35/35, 192 s) all green. RDD: risk high
      (`hot_path` auth, `process_boundary`), consent granted (standing user consent), native
      review refused `lens_context_budget_exceeded` (4669 lines); fallback independent
      security verifier: PASS with issues, all 8 findings fixed in E1.V1. Route: parent inline.

## Acceptance criteria (stage 1)
- Every 2.1 feature works through the server; the 2.1 protections hold (CSP, SRI, `esc()`,
  schema validation, lockout, audit).
- A 2.1 `.txt` (fixture) imports with users, deletions and history intact.
- Unit, integration and E2E suites green locally and in CI; compose smoke test green.

## Applicable checks
- `npm test`, `npm run test:db`, `node tests/e2e/run.mjs`, CI workflow.

## Progress
- 2026-11-07: first delivery (no code) approved with adjustments; E1.T0 done.
- 2026-11-07: E1.T1-E1.T3 done (server scaffold, schema + domain, auth and users).
- 2026-11-07: E1.T4 done (API for every 2.1 operation, SSE, idempotency, demo data).
- 2026-11-08: E1.V1 done (security corrections) and E1.T5 done (`.txt` v2 import/export).
- 2026-11-08: E1.T6 done (Vite frontend over the API).
- 2026-11-08: E1.T7 done (E2E on the v3 server, 35 specs) and E1.T8 done (Docker, Compose,
  backups, CI workflow, LEEME); first CI run pending.
- 2026-11-08: E1.T9 done: CI green after runner-only fixes; stage 1 PR opened.
- 2026-11-08: E2.T1 done (plantillas backend) and E2.T2 done (líneas, sectores, cajas backend).
- 2026-11-08: coverage rule fix, E2.T3 done (frontend) and E2.T4 specs done (43/43 local); CI + PR pending.

## Stage 1 implementation notes (E1.T1-E1.T3)
- Embedded PG runs through the bundled `initdb`/`pg_ctl` of `embedded-postgres`
  (`server/scripts/lib/embedded-pg.js`): `postgres.exe` refuses to start from an elevated
  Windows console, `pg_ctl` starts it with a restricted token. Same package and binaries.
- Dev DB: `npm run db:start` / `db:stop` (cluster in `.pgdata/`, port from `DATABASE_URL`,
  default 54329); `db:migrate` and `db:reset` start it temporarily when it is down.
  Integration tests: temp cluster per test file, or a fresh database per file on
  `TEST_DATABASE_URL` (CI `postgres:16` service).
- DB text limits follow the 2.1 SCHEMA (accept everything a 2.1 `.txt` accepts); API input
  uses the UI limits (LIM). Ledger/history tables (movements, transfers, control items,
  audit, shift changes) have no FKs so references survive logical deletes; live-state tables
  do. Controls are written draft -> items -> finalize (trigger blocks item writes on a
  finalized control).
- Faithful 2.1 quirk kept: inventory message "Solo hay N en en reparación." (POOL label).
- Sessions: idle 12 h / absolute 24 h; "Mantener la sesión" 30 days; expired sessions are
  deleted when used (no periodic sweep yet).
- Wrong current password on change-password also counts toward the lockout.
- Dev users (seed): admin, gerencia, supervisor, responsable, responsable2, consulta, all
  with `panol-dev-1234` (documented in `.env.example`).

## Stage 1 implementation notes (E1.T4)
- Concurrency: every PATCH/DELETE of an editable row (and the shift change and finalize
  POSTs) requires `If-Match`; missing -> 428, stale -> 409 `{error:'conflict', current}`.
  (User routes require it too since E1.V1.)
- Stock: a movement locks its tool row (`FOR UPDATE`) before loading the inventory
  context; unit-code and pending-return uniqueness also rely on the DB indexes.
- Idempotency: table `idempotency_keys` (per user + key, request hash); the key is claimed
  in the same transaction as the write, so a failed write can be retried.
- Demo data (2.1 `demo_manage`): rows flagged `demo`; clearing is the only exception to the
  append-only ledger and finalized controls, allowed by the DB triggers only for demo rows
  inside a transaction with `panol.demo_clear` on. Audit entries are never deleted (2.1
  deleted demo audit). Clearing is refused (409) if real movements/controls point at demo
  techs or tools. Demo unit codes / legajos get a `DEMO-` / `D` prefix when already taken.
- Small additions over 2.1: unit code correction (`PATCH /api/units/:id`), shift order
  edit, alert reopen, last shift cannot be deleted, serialized flag change refused (409)
  instead of silently ignored when the tool has movements.

## Stage 1 implementation notes (E1.V1, E1.T5)
- DB roles: the app connects as `panol_app` (`DATABASE_URL`); migrations and the role
  provisioning run as the owner (`MIGRATION_DATABASE_URL`, `npm run db:migrate` or `main.js`
  at start when set). The server refuses to serve as a superuser or table owner. New
  append-only tables must `REVOKE UPDATE, DELETE` from `panol_app` in their migration.
- Dev/test need an explicit `NODE_ENV` (`.env` from `.env.example`; tests via
  `server/test/test.env`); without it the config is production.
- `.txt` backup limits (to confirm in the stage 1 PR): users are exported without PIN or
  password hashes, so a v3 backup does not restore credentials (an admin resets them) and
  2.1 cannot open a v3 backup that has users (2.1 requires `salt`/`pinHash`; exporting them
  as empty strings would keep 2.1 compatibility without secrets). Export is admin-only (2.1
  let any signed-in user download). The server keeps no tombstones (`deleted: {}`), so a
  merge can bring back a row deleted on the server since the file was saved.

## Stage 1 implementation notes (E1.T6)
- CSP: the 2.1 templates used inline `style="..."` (blocked by `style-src 'self'`); they now
  use `data-css="..."`, applied through CSSOM by `setHTML()` (allowed by CSP). The CSP header is
  sent on every response (API too) with `X-Content-Type-Options` and `Referrer-Policy`; HSTS
  only with `NODE_ENV=production`.
- Static files are served in their own Fastify context marked public (the session is still
  required on every `/api` route); unknown GETs without extension get `index.html`.
- Views and texts are the 2.1 ones; 2.1's client-side derive runs on `GET /api/state`, with the
  current period taken from the server (`derived.cur`). Writes call the API, then refetch.
- Concurrency: editing modals keep the record version; an SSE refresh with a newer version or a
  409 shows "Alguien modificó este registro…" with Recargar / Mantener mis cambios (keep = save
  over the new version, an explicit user choice). The checklist does the same with its draft.
- Offline: only the checklist draft is written while offline (IndexedDB `panol-v3`, store
  `panol-drafts`, key `tech|period[|corr-<id>]`); same content keeps its Idempotency-Key, changed
  content gets a new one; resent on reconnect; a 409 marks it as a conflict instead of retrying.
- Admin › Permisos keeps pending changes with an "unsaved changes" counter (design guide) and
  saves them with one `PUT /api/permissions`; 2.1 saved each toggle immediately.
- `npm run dev` sets `APP_ORIGIN=http://127.0.0.1:5173` for the API (the Origin check must see
  the Vite origin). Build output `web/dist` (ignored); `WEB_DIST` env overrides it.
- Follow-ups: the old 2.1 E2E suite still targets root `index.html` (E1.T7); CSV keeps 2.1's
  quoting (no spreadsheet-formula guard).

## Decisions on the stage 1 PR points (2026-11-08, user delegated: "toma las mejores decisiones")
- Default permissions (supervisor = responsable + `shift_change`; gerencia = read-only +
  `reports_export`), off-VPS copy via rclone to an S3-compatible bucket (B2 or R2),
  usernames derived from names, session timings, temp password shown once: kept as proposed.
- Demo clear: kept (only demo-flagged rows, through a restricted function; audit never deleted).
- `.txt` export without credential hashes: kept (security over 2.1 round-trip for users).
- `.env.example`: unchanged (reads blocked by a user deny rule); variables documented in
  `LEEME.md` and `docker-compose.yml`.
- PR #1 merge stays with the user. Stage 2 is stacked: `v3/etapa-2-plantillas` branches from
  `v3/etapa-1-servidor`, its PR targets `v3/etapa-1-servidor` until #1 is merged, then it is
  rebased onto `v3-servidor`.

## Stage 2 decisions (parent, within PEDIDO §2.2–§2.3)
- Effective plantilla of a tech on a date = the `tech_plantilla_history` range covering it
  (no overlap via exclusion constraint). Temporary coverage = a range with `valid_to` and
  `temporary=true`; after `valid_to` the tech is back in the base range automatically (derived
  by date, no cron job).
- "Turno actual" of a plantilla is informative: a label from a configurable list (default
  Mañana, Tarde, Noche), changed once per plantilla and stored in `plantilla_rotations`.
  Supervisor changes go to `plantilla_supervisor_history` (date, actor).
- Permissions: `shift_change` keeps its key and now means "mover técnicos de plantilla";
  new `plantillas_edit` (create, rename, supervisor, archive; admin by default) and
  `plantilla_rotate` (admin; a supervisor may always rotate their own plantilla).
- Migration of 2.1 turnos: each shift becomes a plantilla with the shift's name, no
  supervisor (assignable later), current shift label = its name; `techs.shiftId` and
  `shiftChanges` become history ranges. `.txt` v2 stays importable; v2 export maps plantillas
  to `config.turnos` and current membership to `techs.shiftId`.
- Cajas compartidas: a holder is a tech XOR a caja (CHECK); controls and assignments
  generalise to the holder; one original control per holder and period. Referente = a tech.
- Line on missing/broken tools stays in stage 4 (optional, never blocks).
- Coverage rule (E2.T3, commit `82f72e7`): a permanent move of a tech who is in (or scheduled
  for) a temporary coverage is allowed from the coverage start onwards: the coverage range is
  shortened to the move date (void if it never started), the automatic return range is voided
  (closed at its own start) and the target becomes the new open range; audit detail says the
  coverage ended and the return was cancelled. A new coverage (`until`) while one is still
  running is refused (422 `coverage_active`, "tiene una cobertura temporal hasta el …").
  Migration 007 lets the history trigger lower `valid_to` of a temporary range only (never
  below `valid_from`); other closed ranges stay immutable. Move-selected checks the plantilla
  the tech is in today (during a coverage, the coverage plantilla).

## Stage 2 tasks (branch `v3/etapa-2-plantillas`)
- [x] E2.T1 Backend plantillas: migration (plantillas, history tables with exclusion
      constraint, rotations, supervisor history, shift labels setting, control
      `plantilla_id_snapshot`), data migration from shifts, domain (effective plantilla by
      date, coverage return), API (CRUD, rotate, change supervisor, move one tech, move
      selected techs in one transaction, coverage with return date, history), permissions,
      SSE, audit, `.txt` import/export mapping; unit + integration tests.
      Route: delegated writer. Code: migration `005_plantillas.sql`, `domain/plantillas.js`,
      `adapters/pg/plantilla-repo.js`, `application/plantillas.js`, `adapters/http/plantilla-routes.js`;
      catalog (techs, legacy turnos and shift change delegate to plantillas), controls (snapshot),
      state, report, seed, demo, `.txt` repo. Test-first: `unit/plantillas.test.js` RED (missing
      module) then GREEN; permissions unit test RED (2 failing on the new keys) then GREEN;
      `plantillas-migration.test.js` found a real bug RED (`by` is a reserved alias in the
      PL/pgSQL record) then GREEN; the other integration tests were written with the code.
      Evidence: `npm test` 109 pass + 1 expected failure (`web/test/constants.test.js`: the
      web PERMS list lacks the 3 new keys; `web/` is the frontend writer's surface);
      `npm run test:db` 112/112 (new `plantillas-api` 15: exclusion 23P01, append-only trigger
      (only closing an open range), app role cannot TRUNCATE/UPDATE/DELETE the append-only
      tables, create with default name "Plantilla de <supervisor>", supervisor must have role
      supervisor, If-Match 428/409, archive only without members, move one (version bump, ETag,
      audit, NOTIFY, same-day re-move voids the range, no move before the last change),
      move-selected atomic rollback + idempotent replay, coverage with automatic return by date,
      rotation (supervisor own only, consulta/gerencia/responsable 403), supervisor history,
      snapshot on create and on finalize, report keeps the control snapshot after a move,
      "Mi plantilla", shift labels; `plantillas-migration` 3: shifts -> plantillas, shift
      changes -> ranges (same day keeps the last, missing source shift = gap, local date of
      `at` when no effective date), snapshot backfill on finalized controls that stay immutable;
      `plantillas-txt` 3: export turnos/shiftId/shiftChanges from plantillas and history,
      import of a new turno + shift change -> plantilla + range, deleted turno -> archived
      plantilla, export -> dry-run = 0 changes; adapted: catalog (shift change and turnos now
      on plantillas), txt-import (membership and plantillas instead of `techs.shift_id`/`shifts`),
      auth (permission map has the 3 new keys)).
- [x] E2.T2 Backend líneas, sectores y cajas: catalog, cajas with referente, holder
      generalisation for assignments, movements and controls, single-form "alta" of an
      assignment to a tech or a caja; tests.
      Route: delegated writer. Code: migration `006_lineas_cajas.sql`, `domain/lineas.js`,
      `application/lineas.js`, `adapters/http/lineas-routes.js`; holder generalisation in
      `domain/{movements,controls,alerts,derive,integrity}.js`, `application/{controls,alerts,read}.js`,
      `adapters/pg/{catalog,inventory,state,txt}-repo.js`, movement/control route schemas.
      Test-first: `unit/holders.test.js` RED (missing module), then GREEN (one wrong regex in
      the test itself fixed); `integration/cajas-api.test.js` written before the code but not run
      RED separately. Evidence: `npm test` 117 pass + 1 expected failure (web PERMS parity, as in E2.T1); `npm run test:db` 121/121 (new
      `cajas-api` 9: lineas_edit only (supervisor/responsable/consulta/gerencia 403), unique
      names, If-Match 428/409, caja needs an active línea and an active referente, DB CHECK
      exactly one holder on assignments/controls (23514), single-form alta by quantity
      (entrega inicial then adicional, idempotent replay, stock check 422) and by several units
      (all or nothing; units held by the caja), alta to a tech with the same endpoint, caja
      control through `/api/controls` with `cajaId` (409 second original, tech and caja same
      period allowed, partial unique index 23505), finalize, `derived.effective`/`cajaInfo`/
      faltante alert with `cajaId`, alert resolution stores `caja_id`, devolución from the caja
      and integrity clean, archive rules (caja with tools 409, línea with active cajas 409,
      archived caja refuses alta and control), `.txt` export without caja rows and export ->
      dry-run = 0 changes). Stage 1 tests unchanged.
- [x] E2.T3 Frontend: Plantillas module replacing Turnos (list, plantilla view based on
      `Turno.dc.html`, select + "Mover seleccionados", "Cambiar de plantilla" from the tech
      sheet based on `CambioTurno.dc.html`, coverage with return date, rotation, supervisor
      change, history), "Mi plantilla" first for supervisors with their alerts, grouping by
      plantilla in panel, filters, reports; Líneas/Sectores/Cajas screens; design guide.
      Commits `82f72e7` (backend coverage rule, see Stage 2 decisions) and `9c8084d`.
      Route: delegated writer. Code: `web/src/state/plantillas.js` (pure: date ranges,
      coverage, report plantilla, grouping, selection, form validation), `features/plantillas/
      {view,move}.js`, `features/lineas/view.js` (catalog, caja sheet, "Asignar herramienta"),
      derive/store/drafts/control/entregas generalised to the holder key (`<techId>` or
      `caja:<id>`, alerts now taken from the server), admin Configuración (shift labels),
      PERMS + labels, routes (`#plantillas`, `#plantilla-<id>`, `#lineas`, `#caja-<id>`,
      `#control-caja:<id>`; `#turnos`/`#turno-<id>` kept as aliases). `shifts_edit` stays in the
      web list for parity but is hidden in the matrix. Test-first: coverage rule RED observed
      (unit `move_before_last` thrown; 2 integration tests failing) then GREEN; web pure modules
      written with their tests (no separate RED run). Evidence: `npm test` 131/131 (constants
      parity fixed; new `web/test/plantillas.test.js` 11, router + drafts caja cases);
      `npm run test:db` 123/123; `npm run build` ok, `web/dist/index.html` with 0 inline
      script/style/handlers.
- [x] E2.T4 E2E: move one and several techs, coverage return, rotation, supervisor view,
      caja assignment + control, `.txt` migration of turnos to plantillas; existing specs
      adapted; CI green; PR.
      Done except CI/PR (parent): commit `d694dcd`. Route: delegated writer. Adapted: route
      list (`plantillas`, `lineas`), `plantilla-<id>` detail, admin tab `config`. New
      `t9-plantillas` (8): move one from the tech sheet (history + report keeps the control
      snapshot, UI and `/api/reports`), "Mover seleccionados" 2 of 3 in one step (audit 2),
      past coverage back in base + coverage from the sheet + second coverage refused (sheet and
      422) + permanent move cancels the return, rotation and supervisor change recorded and the
      supervisor sees Mi plantilla/alerts first and cannot rotate another plantilla (UI, forged
      click, 403), consulta/gerencia cannot move or rotate, línea + caja + one-form assignment +
      caja control finalized, 2.0.0 `.txt` turnos as plantillas, every route incl. new ones at
      1280/390. Evidence: `PANOL_E2E_BUILD=1 npm run test:e2e` 43 passed, 0 failed, 0 skipped
      (326 s; no console/CSP errors). Found and fixed while writing specs: tech/tool ids missing
      from `S.*[id]` objects in the new sheets.
- [x] E2.V1 Correction of the independent stage 2 review (PASS with issues). Route: delegated
      writer (6 items over domain, application, pg adapters, importer and a migration).
      1. Coverage checked against today: `planMove` takes `today` (local date); the coverage
         path applies only when the coverage is running or scheduled (`validTo > today`), the
         move falls before its end, and it was not already cut (a cut leaves the voided return
         starting after the shortened coverage end). Otherwise the normal `move_before_last`
         floor. RED: 2 unit (past coverage voided the lived return; cut coverage voided the
         permanent range) + 2 integration (200 instead of 422) -> GREEN.
      2. One `applyMovePlan` (plantilla-repo: shorten, close, inserts) used by `applyMove` and
         the `.txt` import; every import move (incl. the final "from today") is skipped and
         counted on a DomainError; apply response `report.membershipSkipped`, audit says
         "cambios de plantilla omitidos". RED: active coverage -> 500 (23P01); scheduled
         coverage -> 422 aborting the import -> GREEN (coverage ends today / skipped + counted).
      3. Demo clear nulls `cajas.referente_tech_id` of demo techs first (audit `caja_edit`,
         `deleted.cajasReferente`). RED 500 (FK) -> GREEN.
      4. Lock order plantilla (target) then tech everywhere (`applyMove` incl. version check,
         `moveTech`, legacy `changeShift`; move-selected locks the target once before the
         loop); PG 40P01/40001 -> 409 `{error:'retry'}` in the shared handler. RED: two-connection
         test (external lock on the target, move-selected + move-one) -> 500 deadlock; unit
         mapping test failing -> GREEN (200 + 422 `same_plantilla`, no deadlock).
      5. `.txt` range ids that already exist in the history get a new id (`freeRangeId`, both
         the move and the no-history path). RED 409 `import_conflict` (not 500 as reported) ->
         GREEN.
      6. Migration `008_plantillas_unique_name.sql`: `plantillas_dedupe_active_names()` (suffix
         " (n)" by sort_order, id; audited) + partial unique index `plantillas_active_name_key`
         on `lower(name)` for active rows; API maps 23505 to 409 `duplicate`, import apply to 409
         `duplicate_plantilla_name`, dry-run reports `shifts.name` "nombre de plantilla
         repetido". RED (no index, no report error) -> GREEN. Note: `lower()` follows the DB
         locale (non-ASCII capitals such as Ñ may not fold), same as the existing API check.
      Evidence: `npm test` 136/136; `npm run test:db` 132/132; `PANOL_E2E_BUILD=1 npm run test:e2e` 43/0/0 (318 s). Commit `624b097`
      (`fix(server): ...`, docs amended). Follow-up: `web/src/state/plantillas.js` `coverageOf`/`validateMove`
      still mirror the old rule client-side (web/ outside this surface; the server decides).

## Stage 2 implementation notes (E2.T1)
- Membership: `tech_plantilla_history` ranges `[valid_from, valid_to)` with
  `EXCLUDE USING gist (tech_id WITH =, daterange(...) WITH &&)` (`btree_gist`). `valid_from`
  NULL = "since always" (the first range of every tech, so old controls also find a
  plantilla); `valid_to` NULL = open. A range with `valid_from = valid_to` is void (a second
  move on the same day closes the first one at its own start; nothing is deleted). The only
  UPDATE allowed is closing an open range; DELETE only for demo rows during demo clear.
  SQL helpers: `plantilla_on(tech, day)`, `period_end(y, m, w)`,
  `plantilla_ranges_from_changes(current, changes jsonb)` (used by migration 005 and by the
  `.txt` importer).
- Move rules: from-date must not be before the start of the tech's last range; target must be
  an active plantilla different from the current one; reason required; coverage = `until`
  (exclusive return date: the tech is back in the base plantilla on `until`), stored as a
  temporary range plus a re-opened base range, so "effective plantilla on D" is one lookup and
  no job is needed. A move bumps the tech `version` (open edit forms see the change).
- Control snapshot (`controls.plantilla_id_snapshot`, also mirrored in `shift_id` for 2.1):
  plantilla on min(today, last day of the control's week), taken on create, on each draft
  save and on finalize. Migration backfill used min(finished/updated date, week end), falling
  back to the control's old `shift_id`.
- Rotation: label must be in the configurable list (`app_settings` key
  `plantillas.shift_labels`, default Mañana/Tarde/Noche); migrated plantillas keep their shift
  name as current label; rotation date cannot be in the future. Supervisor change: role
  supervisor and active (or null to remove), date not in the future.
- Legacy routes kept and delegating (so the 2.1 UI keeps working until E2.T3): `/api/shifts`
  POST/PATCH/DELETE = create/rename/archive plantilla (permission now `plantillas_edit`;
  `shifts_edit` stays in the list only for stored overrides and is no longer checked);
  `POST /api/techs/:id/shift-change` = move from `effectiveFrom` (today if empty), reason =
  note or "Cambio de turno". `shifts` and `shift_changes` are no longer written (readable);
  `techs.shift_id` is no longer written either.
- `.txt` v2: export `config.turnos` = active plantillas, `techs.shiftId` = membership today,
  `shiftChanges` = one per history range with a from-date (id = range id, names = current
  plantilla names, temporary flag not represented). Import: new turno -> plantilla (an
  archived one with the same id is re-activated), removed turno -> plantilla archived and its
  members' open ranges closed today; techs without history get ranges from the file's shift
  changes + shiftId; techs with history get new shift changes as moves (those dated before the
  last range are skipped and counted in the import audit) and a move from today if the
  file's shiftId differs. History is never deleted or edited by an import.

## Stage 2 implementation notes (E2.T2)
- Holder = tech XOR caja: `assignments` and `controls` have `CHECK (num_nonnulls(tech_id,
  caja_id) = 1)`; `movements` and `units` at most one. Original control uniqueness is two
  partial unique indexes (per tech, per caja). `controls_guard` also forbids changing
  `caja_id` on a draft (and now compares `tech_id` with IS DISTINCT FROM).
- Domain keys: effective controls/drafts use `<techId>|<pkey>` (unchanged) and
  `caja:<cajaId>|<pkey>`; pending-control alert key for a caja is `pend-caja:<id>-<pkey>`;
  other alert keys are unchanged (they use assignment/movement ids). A caja has no plantilla
  (`plantillaId` null on its controls). Archived cajas get no alerts, altas or controls.
- `.txt` v2 has no cajas: caja assignments, controls, movements and alert resolutions are
  left out of the export (the v2 file's stock then omits what cajas hold), units go out
  without the caja; an import never writes `caja_id`. Backups of v3 data are the pg_dump ones.

## Stage 2 API notes (for the frontend writer)
- `GET /api/state` (backward compatible, new keys): `plantillas` (by id, incl. archived:
  name, supervisorUserId, currentShiftLabel, order, archivedAt, version), `plantillaHistory`
  ({techId: ranges[]}: id, plantillaId, validFrom, validTo, temporary, reason, createdAt, by),
  `plantillaRotations` (list: plantillaId, fromLabel, label, from, by), `plantillaSupervisors`
  (list: plantillaId, fromUserId, supervisorUserId, from, by), `shiftLabels` and
  `config.shiftLabels`, `techs[id].plantillaId` (= `shiftId`, membership today),
  `derived.myPlantilla` = { plantillaIds (active plantillas supervised by the caller), techIds
  (their active members today), alertKeys (open alerts of those techs) }. Unchanged shapes:
  `shifts` (active plantillas as {id, name, order, version}), `config.turnos`, `shiftChanges`
  (now derived from history; ids are range ids), `derived.shiftInfo` (per active plantilla).
- Controls: new field `plantillaId` (snapshot); `GET /api/controls?plantillaId=` filters by it.
- `GET /api/reports`: rows `shiftId`/`plantillaId` = plantilla of the period (control snapshot,
  else history at period end, else current); new `plantillas` (same as `shifts`, may include
  archived plantillas present in the period); `plantilla=` query alias of `shift=`.
- Plantillas: `GET /api/plantillas` (with `members` count), `POST /api/plantillas` {name?,
  supervisorUserId?, shiftLabel?, order?} (201 `{plantilla}`), `PATCH /api/plantillas/:id`
  {name?, order?} + If-Match, `POST /api/plantillas/:id/archive` + If-Match (409 with members,
  409 last one), `POST /api/plantillas/:id/rotate` {label, from?} + If-Match -> {plantilla,
  rotation}, `POST /api/plantillas/:id/supervisor` {supervisorUserId|null, from?} + If-Match ->
  {plantilla, change}, `GET /api/plantillas/:id/history` -> {plantilla, members (ranges),
  rotations, supervisors}.
- Moves (`shift_change`, Idempotency-Key accepted): `POST /api/techs/:id/move` {plantillaId,
  from, reason, until?} (optional If-Match = tech version) -> {tech, ranges}; `POST
  /api/plantillas/:id/move-selected` {techIds[1..200], targetPlantillaId, from, reason,
  until?} -> {moved: [{techId, version, ranges}]}, all or nothing; a 422 names the tech
  (`techId` in the body). `GET /api/techs/:id/plantilla-history` -> {techId, current, ranges}.
- `POST /api/techs` accepts `plantillaId` (or the 2.1 `shiftId`); tech responses carry
  `plantillaId`/`shiftId`. Shift change response adds `range`.
- Shift labels: `GET /api/settings/shift-labels` -> {labels, version} + ETag; `PUT` {labels}
  + If-Match (`plantillas_edit`).
- Permissions: new keys `plantillas_edit`, `plantilla_rotate`, `lineas_edit` (admin only by
  default); `shift_change` label is now "Mover técnicos de plantilla". The web PERMS list
  (`web/src/state/constants.js`) must add the 3 keys (parity test).
- SSE events: `plantillas` (create/update/delete/move) and `techs` (update on every move);
  `lineas`, `cajas` (create/update/delete) and `movements` for altas.
- Líneas/cajas (E2.T2, `lineas_edit`): `GET /api/lineas`, `POST /api/lineas` {name, kind:
  'linea'|'sector', order?}, `PATCH /api/lineas/:id` + If-Match, `POST /api/lineas/:id/archive`
  + If-Match (409 with active cajas); `GET /api/cajas`, `POST /api/cajas` {name, lineaId,
  referenteTechId?}, `PATCH /api/cajas/:id` + If-Match, `POST /api/cajas/:id/archive` + If-Match
  (409 with tools). `/api/state` adds `lineas` and `cajas` (by id) and `derived.cajaInfo`
  (same shape as `techInfo`); `derived.effective`/`drafts` add `caja:<id>|<pkey>` keys.
- Holder fields: assignments, units, movements, controls and alerts carry `cajaId` (null or
  absent for techs); `techId` is null for a caja. Controls of a caja: `techName` is the caja
  name at the time. `POST /api/movements` and `POST /api/controls` accept `cajaId` instead of
  `techId` (both -> 422); `GET /api/controls?cajaId=`.
- Alta (`movements_do`, Idempotency-Key): `POST /api/assignments` {holder: {techId}|{cajaId},
  toolId, qty (by quantity) | unitIds[] (serialized), reason?} -> 201 {movements[],
  assignments[]}; entrega inicial, or adicional when the holder already has that tool; all
  units or none.

- Stage 2 backend live check (after E2.T2): `NODE_ENV=development npm run db:reset` (migrations 005 and 006
  applied, seed loaded), `node server/src/main.js` + curl: health ok, admin login 200, `POST /api/plantillas`
  201, `POST /api/plantillas/manana/move-selected` (2 techs) 200, `GET /api/state` 200 with both techs in
  the new plantilla; server and `db:stop` stopped. `npm run test:e2e` 35 passed, 0 failed (255 s; stage 1
  specs untouched and still green thanks to the delegating legacy routes).

## Stage 2 close (parent)
- Web parity: `coverageOf` in `web/src/state/plantillas.js` now ignores a coverage already cut
  by a permanent move, like the server's `activeCoverage` (RED 11/12 → GREEN 12/12 in
  `web/test/plantillas.test.js`). Route: parent inline (one mechanical, understood file).
- Decision: a `.txt` import that meets a scheduled coverage skips that membership change and
  counts it in the report and audit (the planned coverage wins over an older file).
- Verification before push: `npm test` 137/137; `PANOL_E2E_BUILD=1` E2E `t9` 8/8. Stage 2 CI
  run 42487438456 (before E2.V1): 4 jobs green, E2E 43/43; final CI run on the PR.
- RDD: risk high (4604 lines); native review not attempted at this size (refused with
  `lens_context_budget_exceeded` in stage 1); fallback independent verifier: PASS with
  issues, 5 findings + 1 pre-existing, all fixed in E2.V1.

## Stage 3 decisions (parent, within PEDIDO §2.4–§2.5)
- Especialidad: configurable catalog (defaults Mecánico, Electricista, Electro-mecánico,
  Refrigeración, Soldador, Edilicio, Servicios Generales, Ingeniería, Pañolero), optional
  field on techs; filter in Técnicos/Controles/Alertas/Reportes and a column in reports and
  exports (printing comes in stage 10).
- Kit base = editable ordered list of tools with quantities (the `BLANCO` equivalent); optional
  kits per especialidad. "Entregar kit" delivers a whole kit to a tech or caja in ONE
  transaction, one movement per tool (entrega inicial, or adicional when the holder already has
  it); all or nothing on stock; skipped serialized tools without enough units are refused, not
  silently dropped.
- Custom order: `sort_order` on categories and tools (global). Drag and drop on desktop
  (pointer events, keyboard accessible), up/down arrows on mobile; "insertar en posición" when
  creating a tool. Applied in control, ficha, inventario, reportes and Excel (printing in
  stage 10). Reordering is one request with the full ordered id list and `If-Match` on a
  per-scope order version, so two people reordering at once get a 409.
- Per-tech custom order (PEDIDO "Opcional"): not implemented in this stage, to keep one order
  that matches the physical box; recorded as a possible follow-up.
- Permissions: new `kits_edit` (admin; responsable may deliver kits through `movements_do`);
  ordering uses `tools_edit`; especialidades catalog uses `techs_edit`.

## Stage 3 tasks (branch `v3/etapa-3-kit-orden`, stacked on stage 2)
- [x] E3.T1 Backend: especialidades catalog + tech field, kits (base + per especialidad) with
      items and quantities, deliver-kit endpoint, ordering for categories and tools (insert at
      position, full-list reorder with version), report/state/export changes, `.txt` v2
      compatibility (especialidad and order are not in v2: export ignores, import keeps
      defaults); unit + integration tests.
      Commit `dca6440`. Route: delegated writer. Code: migration `009_especialidades_kits_orden.sql`,
      `domain/{orden,kits}.js`, `application/{orden,kits}.js`, `adapters/pg/kits-repo.js`,
      `adapters/http/kits-routes.js`; catalog (tech `especialidadId`, tool `position`, category and
      tool order scopes), derive (custom order), report (especialidad filter/column, `tools`),
      state, `.txt` repo. Test-first: `unit/orden.test.js` + `unit/kits.test.js` RED (missing
      modules) then GREEN 12/12; `integration/kits-orden-api.test.js` (13) written before running,
      first run found 2 wrong expectations in the test itself (seed rows are inserted after the
      migration, so they get the "append" order; `.txt` stamp must be ISO), no code change.
      Evidence: `npm test` 149/149; `npm run test:db` 145/145 (new 13: 9 default especialidades
      and empty base kit, especialidad CRUD perms/409/428/archive rules, tech field + report filter
      and column, reorder categories (403/428/409 stale with `current`/409 `order_changed`/422
      duplicates, tool/category versions unchanged by a reorder), tools per category and "sin
      categoría", insert at position, category change appends and bumps both scopes, report tool
      order, kit PUT perms/If-Match/422/400, per-especialidad kit unique + delete, base kit not
      deletable, deliver: one movement per tool, idempotent replay, adicional the second time,
      stale If-Match 409, chosen unit, short stock 422 `kit_stock` with `problems` and no
      movement/audit/assignment written, deliver to a caja; `.txt` export without especialidad/
      order, export -> dry-run = 0 changes, imported new tool appended, other orders unchanged).
- [x] E3.T2 Frontend: especialidad on tech form/sheet and filters, Configuración ›
      Especialidades, Kits screen (edit base kit and per-especialidad kits, reorder),
      "Entregar kit" from the tech/caja sheet with a preview of what will be delivered and stock
      problems, ordering UI (drag and drop desktop, arrows mobile, insert at position),
      order applied everywhere listed above; design guide.
      Commit `db1da67`. Route: delegated writer. Code: `web/src/state/{orden,kits}.js` (pure),
      `ui/sortable.js` (pointer events on a handle, Alt+↑/↓, 44 px arrows; re-finds the list by
      scope and id when an SSE render replaces it mid-drag: found by the E2E drag test),
      `features/config/view.js` (tabs Herramientas / Kits / Especialidades; pending order with
      "Guardar orden"/"Descartar" and a conflict notice on 409; "Insertar en posición" in the new
      tool form), `features/kits/deliver.js` ("Entregar kit" preview + one confirm), especialidad
      in tech form/sheet/list and filters in Técnicos, Historial, Alertas and Reportes, report
      column + "Por herramienta" table, CSV/Excel/PDF "Por herramienta" sheet and Especialidad
      column, derive/control detail in custom order. Pure modules written with their tests (no
      separate RED run). Evidence: `npm test` 154/154 (new `web/test/orden-kits.test.js` 5);
      `npm run build` ok, `web/dist/index.html` with 0 inline script/style/handlers.
- [x] E3.T3 E2E: especialidad filter and report column, edit base kit, deliver a kit in one
      step (one movement per tool, stock refused when short), reorder categories and tools on
      desktop (drag) and mobile (arrows), order reflected in control/ficha/inventario/report/
      Excel, insert at position, concurrent reorder 409; CI green (pending, parent); PR (pending,
      parent).
      Commit `a88f4fb`. Route: delegated writer. New `t10-kits-orden` (4): especialidad via the
      tech form, Técnicos filter, report column/filter (UI + API); base kit edited in the UI (add,
      qty, arrow reorder, save) and delivered from the sheet (preview, 3 movements, all entrega
      inicial; second preview says Adicional), short stock named in the preview, confirm refused
      with a message and 0 movements, API 422 `No se entregó nada.`; drag and drop (CDP mouse
      events) of categories and tools at 1280 plus Alt+↑, order in control checklist, ficha,
      inventario, report table and the Excel sheet "Por herramienta", insert at position 2; arrows
      44 px at 390 without drag handle, two sessions reorder categories -> second gets "Otra
      persona cambió el orden" and the first order is kept; all routes + config tabs + the kit
      sheet at 390 and 1280 without overflow or console/CSP errors. Existing specs unchanged.
      Evidence: see Stage 3 verification below.

- [x] E3.V1 Independent review (PASS with issues) corrections, test-first. Route: delegated writer.
      1. Reorder/insert-at-position vs deliver kit deadlock: RED `orden-concurrency` "reordenar y
         entregar kit" = `40P01 deadlock detected` -> `writeOrder` locks rows by id first -> GREEN.
      2. Archive especialidad vs assigning it: RED tech kept an archived especialidad and a kit was
         created for one -> `lockActiveEspecialidad` (`FOR SHARE`) in `checkEspecialidad` and
         `createKit` -> GREEN (422 `invalid_especialidad`); archive already locks `FOR UPDATE`
         before counting (guard test: waits for an assignment in flight and answers 409).
      3. Kit preview auto-picked units after the user unchecked all: RED web unit test (chose
         `['u1','u2']`) -> `kitPreview(..., { autoPick })`, auto-pick only on first load
         (`st._init`), chip "Elegí unidades", confirm refused with "elegí N unidades" -> GREEN.
      4. `updateTool` scopes: no RED reachable on the current code (the If-Match check already
         rejects a category that changed between the unlocked read and the row lock). The literal
         suggestion (lock the row first) was tried and deadlocked against a reorder (`40P01`, test
         "reordenar y cambiar de categoría a la vez"), so the order stays scope -> row: scopes sorted,
         explicit 409 if the locked row's category differs, scopes bumped from the same sorted list.
         Guard tests for both cases.
      5. `.txt` import did not bump order versions: RED (`tools:cat-manuales` stayed 1) -> import
         locks candidate scopes before applying and bumps the scopes whose members changed -> GREEN;
         an open reorder with the old version gets 409.
      6. Migration 010 (`es-x-icu` order for scopes at their initial version): RED
         `orden-migration` with 009 only (database collation order differs from
         `localeCompare('es')`) -> GREEN with 010; versions unchanged; a scope at version 2 untouched.
         `es-x-icu` verified present in embedded-postgres 16 (Windows); `postgres:16.14` (Debian) is
         built with ICU (CI run confirms).
      Commits: `82d362c` (server, items 1, 2, 4, 5, 6 + tests) and the web commit after it (item 3 +
      this entry).
      Verification (local, sequential): `npm test` 155/155; `npm run test:db` 156/156 (new
      `orden-concurrency` 7, `orden-migration` 4); `PANOL_E2E_BUILD=1 npm run test:e2e` 47 passed,
      0 failed, 0 skipped (364 s).

## Stage 3 verification (local, sequential)
- `npm test` 154/154; `npm run test:db` 145/145; `npm run build` ok (0 inline script/style/
  handlers in `web/dist/index.html`); `PANOL_E2E_BUILD=1 npm run test:e2e` 47 passed, 0 failed,
  0 skipped (384 s). A first full run had 46/1: `t3-merge` "negative pool" read the state right
  after clicking "Crear herramienta" without waiting for the sheet to close (race; it passed
  alone). Fixed in the spec by waiting for the sheet to close (`1b31808`).

## Stage 3 API notes (for the frontend and later stages)
- `GET /api/state` adds `especialidades` (by id, incl. archived: name, order, archivedAt,
  version), `kits` (by id: name, especialidadId (null = base kit), version, items [{toolId,
  qty}] in order) and `orderVersions` ({ categories, 'tools:<categoryId>', 'tools:' }: version
  of each order scope, 1 when never reordered). `techs[id].especialidadId`, `categories[id].order`
  and `tools[id].order` (order inside its category) are new fields.
- Especialidades (`techs_edit`): `GET /api/especialidades`, `POST` {name, order?} -> 201
  {especialidad}, `PATCH /:id` {name?, order?} + If-Match, `POST /:id/archive` + If-Match (409
  `especialidad_in_use` with active techs, `especialidad_has_kit`). Techs accept `especialidadId`
  (null clears; archived refused 422 `invalid_especialidad`).
- Kits: `GET /api/kits`; `POST /api/kits` {especialidadId, name?} (`kits_edit`, 409 if that
  especialidad already has one); `PUT /api/kits/:id` {name?, items?: [{toolId, qty 1..10000}]}
  + If-Match (full list, its order is the kit order); `DELETE /api/kits/:id` + If-Match (base kit
  409 `kit_base`). `POST /api/kits/:id/deliver` (`movements_do`, Idempotency-Key, optional
  If-Match = kit version -> 409 when stale) {holder: {techId}|{cajaId}, unitIds?: {toolId:
  [unitId]}, reason?} -> 201 {kit: {id, version}, movements[], assignments[]}; one movement per
  tool (per unit for serialized tools; units auto-picked by code when not given), entrega inicial
  or adicional; 422 `kit_stock` {message "No se entregó nada. …", problems: [{toolId, toolName,
  message}]} and nothing written. Audit `kit_deliver` + one `movement` per movement.
- Order (`tools_edit`): `PUT /api/categories/order` {ids} and `PUT /api/tools/order`
  {categoryId|null, ids} + If-Match (scope version) -> 200 {scope, ids, version} + ETag; 428
  without If-Match; 409 `conflict` (stale) or `order_changed` (list differs from the current
  set), both with `current: {scope, ids, version}`; 422 `invalid_order` for repeated ids.
  `POST /api/tools` accepts `position` (1-based within its category; default end). A category or
  tool created without position or a category change appends at the end and bumps the scope
  version; a `.txt` import appends new rows at the end and bumps every scope whose members it
  changed (categories, the old and new tool scopes), so an open reorder screen gets a clean 409;
  changing only `sort_order` does not bump the row version.
- `GET /api/reports?especialidad=<id>|none`: rows add `especialidadId`/`especialidad`; new
  `tools` ([{id, name, categoryId, bueno, cambio, faltante, pendiente, total}] in custom order).
- Permission `kits_edit` (admin by default; web PERMS parity updated).
- `.txt` v2 export leaves out `especialidadId` and `order`; kits/especialidades are not exported.

## Stage 3 implementation notes
- Order scopes: `order_versions` row per scope, locked (`FOR UPDATE`) before the rows it orders
  (createTool/createCategory/deleteCategory/updateTool category change lock the scope first).
  Triggers (migration 009): `categories_order`/`tools_order` fill `sort_order` at the end when it
  is NULL and on a category change; `touch_row_unless_order` keeps `version`/`updated_at` when only
  `sort_order` changed. Backfill = alphabetical order at migration time; migration 010 recomputes
  it with `name COLLATE "es-x-icu", id COLLATE "C"` (= `localeCompare('es')`, independent of the
  database collation) for scopes still at their initial version (no `order_versions` row or
  version 1), without bumping any version. Fallbacks inside 010: `und-x-icu`, then a deterministic
  lower/unaccent expression with ñ between n and o (both target builds have `es-x-icu`).
- Global lock order (E3.V1): order scope (`order_versions`, sorted) -> rows by id. `writeOrder`
  locks the rows `ORDER BY id FOR UPDATE` before writing (reorder, insert at position);
  `updateTool` derives the scopes from an unlocked read, locks them sorted, then the tool row, and
  answers 409 if the category changed in between. Especialidad read `FOR SHARE` when assigned to a
  tech or a kit; archive locks it `FOR UPDATE` before counting.
- Deliver kit locks: kit `FOR SHARE`, holder (tech or caja) `FOR SHARE`, then tools by id
  `FOR UPDATE`; one inventory context, plans chained in memory (`planKitDelivery`), all applied or
  none. `kit_items` cascade on tool delete (only demo clear deletes tools).
- Especialidades/Kits live in Configuración de herramientas (tabs); the admin Configuración tab
  is unchanged. Per-tech custom order: not implemented (stage 3 decision).
- Migration 009/010 backfill with existing rows: `integration/orden-migration.test.js` (E3.V1).

## Stage 3 close (parent)
- CI run 42541148526 (with E3.V1): unit, integration (incl. `orden-migration` on
  `postgres:16.14`, so `es-x-icu` is available there), compose and E2E 47/47 green. Local
  spot check `npm test` 155/155.
- RDD: risk high; native review not attempted at this size; fallback independent verifier:
  PASS with issues, 6 low/medium-low findings, all fixed in E3.V1 (two accepted deviations:
  lock order stays scope → row; `es-x-icu` instead of `und-x-icu`).
- PR #3 `v3/etapa-3-kit-orden` → `v3/etapa-2-plantillas` (stacked).

## Stage 4 decisions (parent, within PEDIDO §2.6 and the user's answers)
- Count by quantity: for an assignment with qty > 1 the control records `qty_good`,
  `qty_change` and `qty_missing` with `good + change + missing = expected` (the UI asks for
  "en buen estado" and "requieren recambio"; missing is the rest). With qty = 1 the three
  buttons Bueno / Cambio / Faltante stay. Any missing quantity requires a note (motivo).
- "Requiere recambio" never counts as missing anywhere (reports, alerts, stock): no 0.5 tricks.
- Item state derived for alerts and history: faltante if missing > 0, else cambio if
  change > 0, else bueno. Consecutive alerts compare per assignment with the same rule.
- Migration of existing control items: bueno → good = qty; cambio → change = qty;
  faltante → missing = qty (notes kept). Finalized controls are immutable, so the migration
  writes the quantity columns under the same controlled path used by other data migrations
  (no trigger bypass outside the migration).
- Cleaning, per control (user-confirmed): one item "Limpieza de herramientas y caja" with
  Limpio / Requiere limpieza; "Requiere limpieza" requires a note. Required to finalize a new
  control (it is part of the checklist); old/imported controls have it NULL ("sin dato").
  Shown in the ficha, control detail, reports (% limpio) and the alert "limpieza" when two
  consecutive effective controls of the same holder require cleaning. Printing in stage 10.
- Optional line on missing or change items (user: optional, never blocks): a línea/sector
  select on items with missing or change; reports group losses/breakages by línea.
- Stage 7 will create purchase requests from missing/change quantities; this stage only
  stores the counts and keeps a stable key per assignment for that.
  Record for stage 7 (E4.V1, no code yet): purchase requests must dedupe per assignment (or
  unit) and period / effective control, never per alert key — a correction creates a new alert
  key (`falt-<asg>-<ctl>` changes with the control id), so keying by alert would open a second
  request for the same loss.
- `.txt` v2: export maps quantities back to a v2 item state with the derived rule (and
  `qty`); cleaning and line are not in v2. Import of v2 items uses the migration mapping.
- Cleaning in corrections (parent, E4.V1): a correction of an old control whose corrected
  control has NULL cleaning may be finalized without cleaning (it stays NULL, "sin dato"; if
  "Requiere limpieza" is chosen the note is still required). New originals and corrections of
  controls that had cleaning still require it. Domain `cleaningRequiredFor(corrected)` +
  `validateFinalize(..., { cleaningRequired })`; the web Finalizar reason follows the same rule.
- A línea never makes a draft fail (parent, E4.V1): only items with missing + change > 0 keep a
  línea; an archived/unknown new línea is dropped to NULL with a non-fatal warning, and an
  offline draft rejected by the server is kept on the device marked "necesita revisión".

## Stage 4 tasks (branch `v3/etapa-4-conteo`, stacked on stage 3)
- [x] E4.T1 Backend: migration (item quantity columns + check, item `linea_id`, control
      cleaning status + note, data migration of existing items), domain (finalize validation
      with quantities, cleaning and notes; derived item state; counts; alerts incl.
      consecutive cleaning; reports by units and % limpio; losses by línea), API changes,
      `.txt` mapping; unit + integration tests.
      Route: delegated writer. Code: migration `011_conteo_limpieza.sql`, `domain/controls.js`
      (`itemQuantities`, `itemState`, `asgUnits`, `cleanCleaning`, finalize with cleaning),
      `domain/alerts.js` (faltante/cambio by quantity, `limpieza`), `domain/report.js` (units,
      % limpio, `lineas`), `domain/derive.js`, `application/controls.js` (merge of quantities,
      línea check `FOR SHARE`, cleaning, finalize body), `adapters/pg/{inventory,txt}-repo.js`,
      `adapters/http/operation-routes.js` (strict item/cleaning schemas), demo cleaning.
      Test-first: not observed (domain written first, then `unit/conteo.test.js` 6,
      `integration/conteo-api.test.js` 9 and `integration/conteo-migration.test.js` 3). The first
      run of the migration test was RED for a real defect (`control_items_state_check` already
      existed as the column CHECK name) -> constraint renamed `control_items_state_derived_check`
      -> GREEN. Existing tests changed only where the contract changed: `validateFinalize`
      result has `cleaning`, item doc has the quantity fields, report totals have the cleaning
      fields, and successful finalizes in 4 integration files send `{ cleaning: { status:
      'limpio' } }` (the 422 expectations for pending/missing note are unchanged).
      Evidence: `npm test` 161/161; `npm run test:db` 168/168.
- [x] E4.T2 Frontend: checklist with quantity inputs (steppers ≥44px) for qty > 1 and the
      three buttons for qty = 1, live "faltan N" with required motivo, optional línea on
      missing/change, cleaning item with required note, finalize disabled with the exact
      reason, control detail/ficha/history/report changes, offline draft compatible; design
      guide.
      Route: delegated writer. Code: `web/src/state/conteo.js` (pure: quantities, derived state,
      summary and the exact Finalizar reason, units per assignment, % limpio, losses by línea),
      `features/control/view.js` (qty = 1 radiogroup; qty > 1 "En buen estado" / "Requieren
      recambio" steppers 46 px + numeric input clamped to the assigned qty, live "Faltan N" /
      "Están todas", "Todas en buen estado"; motivo block with quick-phrase chips (required when
      missing > 0, optional observation with change only); "Línea o sector donde se trabajaba
      (opcional)" select; card "Limpieza de herramientas y caja" Limpio / Requiere limpieza with
      required note and chips; Finalizar disabled with the reason in server order; confirmation
      sheet in units with cleaning and the alert count; focus kept when a card re-renders),
      `state/drafts.js` (cleaning in the offline record and request; old records still valid),
      `state/derive.js` (quantities in `stateOf`, units in summaries), control detail (Bien /
      Recambio / Faltan / Línea columns, cleaning card, "Sin dato de limpieza" for old ones),
      tech and caja sheet (quantities line, last cleaning), history rows, alerts (`limpieza`
      icon, KPI, "Ver control"), reports (% limpio KPI and columns, "Faltantes y recambios por
      línea"), CSV/Excel/PDF (% limpio, "Por línea"), `api/index.js` (save/finalize bodies),
      icon `clean`, styles in `v3.css` (classes only, no inline styles).
      Test-first: not observed; `web/test/conteo.test.js` (5) written with the module.
      Evidence: `npm test` 166/166; `npm run build` ok, `web/dist/index.html` has no inline
      script/style/handlers (one module script tag).
- [ ] E4.T3 E2E: quantity control with good/change/missing and required motivo, qty = 1
      buttons, cleaning required to finalize and its note, consecutive cleaning alert,
      change never counted as missing in report, optional línea and report by línea, old
      controls still readable, offline draft with quantities; CI green; PR.
      [x] E2E items (route: delegated writer, commit `7c71cba`); [ ] CI green (pending, parent);
      [ ] PR (pending, parent). New `t11-conteo` (5): steppers (≥44 px, clamped typing, live
      "Faltan N" / "Están todas"), three radio buttons for qty = 1, each Finalizar reason in
      order, motivo via chip, línea select, cleaning note required, confirmation in units
      (4/1/1, cleaning, 2 alerts), stored quantities/línea/cleaning, detail and sheet;
      consecutive cleaning alert shown and resolved in the UI; report row 3/2/1 = 50 % and
      % limpio 0 % (UI cells and API); losses by línea (Línea Envasado 0/2, Sin línea 1/0);
      2.0.0 `.txt` controls readable ("Sin dato de limpieza", quantities from state); offline
      draft keeps `good/change/expected` and cleaning in IndexedDB and is resent with them;
      every route + checklist + reports at 1280 and 390 without overflow or console/CSP errors.
      Adapted specs (UI legitimately changed): `t6-flows` and `t9-plantillas` pick "Limpio"
      before finalizing; `t10-kits-orden` reads the checklist order from `#ckitems` (the
      cleaning card follows the tools).
      Evidence (local, sequential): `npm test` 166/166; `npm run test:db` 168/168; `npm run
      build` ok (0 inline script/style/handlers); `PANOL_E2E_BUILD=1 npm run test:e2e` 52
      passed, 0 failed, 0 skipped (399 s). A first full run was 51/1 (the `t10` order assertion
      included the new cleaning card title), fixed in the spec as above.
- [x] E4.V1 Correction task (review findings). Route: delegated writer (2+ non-trivial files:
      server application/domain/adapter, web state/view, tests). Test-first per item:
      1. MEDIUM, offline draft lost because of a línea. RED: `conteo-api` "línea archivada o
         desconocida al guardar" (422 instead of 200) and the correction finalize with an
         archived línea (422); `web/test/drafts` "un rechazo (422/400) no borra el borrador"
         (draft deleted); `web/test/conteo` `apiItems` (missing export). GREEN: `resolveLineas`
         in `application/controls.js` (create, PATCH, finalize) keeps `lineaId` only when the
         resulting item has missing + change > 0 and drops a new archived/unknown one to NULL
         with `warnings: [{ code: 'linea_dropped', assignmentId }]`; web sends every item
         through `apiItem`/`apiItems` (draft record, PATCH/POST, finalize) and `setItem` clears
         the línea when the item goes back to bueno; `flushDrafts`/`sendLocal` never delete a
         draft on 400/422/404/403: it stays marked `review: { message }` with a visible "Este
         borrador necesita revisión" banner (`#ckreview`, server message, "Guardar de nuevo" /
         "Descartar borrador"), and is deleted only after a successful save or an explicit
         discard; a `linea_dropped` warning shows a toast and clears the línea in the open
         checklist. E2E `t11-conteo` "offline draft with a línea survives the línea being
         archived elsewhere" (archived through `srv.app.inject` while the proxy is offline):
         written with the fix, RED not observed.
      2. LOW, `.txt` counts. RED: `conteo-api` ".txt v2: al importar, los totales salen de los
         ítems" (count_* {2,0,1} vs items {0,0,3}). GREEN: `txt-repo.js` `countsOf(items)` on
         insert and update of imported controls; lossy note in Stage 4 API notes.
      3. DECISION, cleaning in corrections. RED: unit `cleaningRequiredFor` (missing export),
         `conteo-api` "limpieza en correcciones" (422). GREEN: domain `cleaningRequiredFor` +
         `validateFinalize(..., { cleaningRequired })`, finalize looks up the corrected control;
         web `ckSummary(..., { cleaningRequired })`, the cleaning card says "Opcional: el control
         que corregís no tiene dato de limpieza", the confirmation shows "Sin dato".
      4. Stage 7 dedupe recorded under Stage 4 decisions (no code).
      Contract change in an existing test: `conteo-api` no longer expects 422 `invalid_linea`.
      Evidence (local, sequential): `npm test` 169/169; `npm run test:db` 172/172;
      `PANOL_E2E_BUILD=1 npm run test:e2e` 53 passed, 0 failed, 0 skipped (394 s).
      Commit: `fix(controls): keep offline drafts on línea and validation errors`.

## Stage 4 API notes (for the frontend and later stages)
- Control item (GET `/api/state`, `/api/controls`): `state` (derived: faltante if `missing` >
  0, else cambio if `change` > 0, else bueno), `qty` (= `expected`), `expected`, `good`,
  `change`, `missing`, `lineaId` (only on items with missing or change), `note`, plus the 2.1
  copies. Control: `cleaning: { status: 'limpio' | 'requiere_limpieza' | null, note }`
  (null = sin dato: old and imported controls). `counts` are units (Σ good / change / missing).
- Input item (POST `/api/controls`, PATCH `/api/controls/:id`, POST `.../finalize`):
  `{ state }` (three buttons, or a shortcut for all units) or `{ good, change }` (missing = the
  rest; optional `missing` must match; optional `state` must match the derived one), optional
  `expected` (the quantity it was counted against: if it is no longer the assigned qty the item
  becomes pending, no error, so an offline draft is never lost), `note`, `lineaId` (only
  considered when the resulting item has missing + change > 0, otherwise stored NULL; a línea
  the item already had is kept even if archived). 400 on schema errors (missing `change`,
  negatives, decimals, extra keys); 422 `invalid_count` (good + change > expected, sums or state
  do not match). E4.V1: no more 422 `invalid_linea` — a new archived/unknown línea is stored
  NULL and the 200/201 response adds `warnings: [{ code: 'linea_dropped', assignmentId }]`
  (create, PATCH and finalize alike, so a synced offline draft can still finish).
- `cleaning` in POST/PATCH/finalize: `{ status, note }` or null (clears); omitted keeps the
  stored one. PATCH needs `items` or `cleaning`. Finalize accepts an optional body `{ items?,
  cleaning? }` merged like a draft save in the same transaction. Finalize 422
  `control_incomplete` messages, in order: "Falta(n) N herramienta(s) por controlar.",
  "Completá el motivo de N faltante(s).", "Indicá la limpieza de herramientas y caja.",
  "Completá la nota de limpieza." (extra `cleaning: 'pending' | 'note' | null`). Required for
  every original and for corrections of controls that had cleaning (the correction copies the
  source cleaning). E4.V1: a correction of a control with NULL cleaning may finalize without
  it (stays NULL).
- Corrections copy quantities, `expected`, notes, `lineaId` and cleaning.
- Alerts: `falt-<asg>-<ctl>` when missing > 0 (text "…: faltan M de N" when N > 1, `qty`),
  `camb-`/`cons-<asg>-<ctl>` when change > 0 (consecutive = the previous effective control of
  that assignment also had change > 0); both can exist for one item. New `limp-<holderKey>-<ctl>`
  (type `limpieza`, sev 2, "Requiere limpieza en controles consecutivos", `controlId`) when the
  last two effective controls of an active holder both require cleaning; resolvable like the
  others; a new control re-opens it with a new key.
- Reports: `bueno/cambio/faltante` and % en condiciones in units (good / counted units);
  current state per assignment from its last effective control (by state for all units if the
  assigned qty changed since). Rows, plantillas and totals add `limpio`, `sucio`, `pctLimpio`
  (effective controls of the period with cleaning data; null when none). New `lineas`:
  [{ id (null = "Sin línea"), name, kind, faltante, cambio }] from the last effective control
  of the period of each holder (cajas only without tech/plantilla/especialidad filters).
- `.txt` v2: export leaves out `cleaning` and the item quantity fields/`lineaId` (state is the
  derived one, `qty` = expected); import maps state -> quantities like migration 011.
  `.txt` v2 is lossy for per-unit quantities: a control of 3 units with 2 good and 1 missing
  exports as `faltante` x 3 and imports as 3 missing. E4.V1: on import the control `count_*`
  are derived from the mapped items (the file's `counts` are ignored), so totals always equal
  the items.

## Stage 4 implementation notes
- Migration 011: the `state` column stays (safer than replacing every read: history,
  transitions, alerts, `.txt` and 2.1 readers keep working) and a CHECK keeps it equal to the
  derived rule (except legacy items with qty 0, which only a `.txt` can bring). `qty` stays
  equal to `qty_expected` (CHECK). Data migration: the item immutability trigger is disabled
  only around one UPDATE inside the migration transaction and re-enabled right after (same
  pattern as 005); `conteo-migration.test.js` checks the trigger is enabled (`tgenabled = 'O'`),
  finalized items still reject writes, totals/versions of controls are unchanged.
- Lock order unchanged: control row `FOR UPDATE` -> assignments `FOR SHARE` -> new líneas
  `FOR SHARE` (sorted). Archiving a línea does not lock controls or assignments.

## Stage 4 close (parent)
- CI run 42566597457 (with E4.V1): unit, integration, compose and E2E 53/53 green. Local
  spot check `npm test` 169/169.
- RDD: risk high; fallback independent verifier: PASS with issues (1 medium offline-draft
  data loss, 1 low `.txt` count mismatch, 1 forward note for stage 7), all handled in E4.V1;
  the draft sync no longer deletes drafts on any rejection (pre-existing policy changed).
- PR #4 `v3/etapa-4-conteo` → `v3/etapa-3-kit-orden` (stacked).

## Stage 5 decisions (parent, within PEDIDO §2.10)
- One model for "Eliminar": logical archive by default for techs, cajas, tools (and their
  units), categories, plantillas, líneas/sectores, especialidades, kits and users
  (`archived_at`, `archived_by`, `archive_reason`, plus `version`). Archived records are hidden
  from lists and selectors but stay in history, reports, audit and printing (names resolved
  with an "(eliminado)" mark). Every existing hard DELETE route of stages 1–4 becomes archive.
- Restore from Administración › Registros eliminados (filter by type, search, who/when/why),
  restoring with its version; conflicts (e.g. an active name or legajo/code now taken) are
  refused with a clear message.
- Definitive deletion only when the record has no history, with double confirmation typing the
  exact name; the server re-checks "no history" in the same transaction under a row lock. The
  audit entry keeps the name. History (relaxed in E5.V1, parent decision) = operational
  references only: movements/transfers, controls/items, assignments, units with movements,
  plantilla membership ranges (beyond the creation range), plantilla supervisor (any row,
  including the one written at creation) and rotation history, kit membership of a tool, current
  references (caja referente, tech especialidad, tool category, línea of a caja) and non-edit
  lifecycle audit actions on the record itself (deactivate/reactivate, kit delivery, rotation,
  toggle, password reset). Plain edits (`*_edit`, `*_update`, `*_rename`, `*_reorder`) and
  audit-only past relations do not block. Audit rows are never deleted.
- Kit items (E5.V1, parent decision): a tool that belongs to a kit has history (no definitive
  delete; the FK cascade never runs). Archiving it removes it from its kits, locking those kits
  (sorted by id) before the tool.
- Archiving a tech or caja with tools assigned: the archive request must include a resolution
  for every active assignment in the same step (devolución to a pool condition, or retiro);
  the server applies those movements and the archive in ONE transaction, or refuses listing
  what is pending. A plantilla can be archived only with no current members; a category only
  when its active tools are archived or moved; a tool only with stock not assigned.
- Anular movement: creates a counter-movement (`voids_movement_id` unique, reversed
  transfers, same tools/units/holder) after checking the reversal is possible with current
  stock and assignment state (refuse with the reason otherwise — e.g. a later movement depends
  on it). The original is never deleted or edited; both show "Anulado"/"Anulación" in history.
  A void cannot be voided; voiding an entrega closes/reopens assignments consistently.
- Permissions: new `records_delete` (archive/restore/definitive) and `movements_void`, admin
  only by default, configurable. Every action requires a motivo and goes to audit.
- Users: archive = deactivate + hide; the last active admin cannot be archived; definitive
  only for users with no audit/actions.
- `.txt` v2: archived records are exported as active=false where v2 has the field and as
  tombstones in `data.deleted` otherwise (so 2.1 merges do not resurrect them); import keeps
  server archive state (a newer file record does not un-archive silently — it is reported).

## Stage 5 tasks (branch `v3/etapa-5-eliminar`, stacked on stage 4)
- [x] E5.T1 Backend: migration (archive columns where missing, `voids_movement_id`, perms),
      domain (history checks, archive preconditions, void planning with reversibility
      checks), API (archive with resolutions, restore, definitive delete, list archived,
      void movement), replace hard deletes, `.txt` mapping; unit + integration tests.
      Commit `f9b23fa`. Route: delegated writer. Code: migration `012_eliminar_anular.sql`,
      `domain/{records,voids}.js`, `application/{records,voids}.js`,
      `adapters/http/records-routes.js`; the old archive routes (plantillas, líneas, cajas,
      especialidades) and the hard DELETEs of categories and kits are replaced by the generic
      routes (the old app functions delegate). Test-first: `unit/permissions` (new keys) RED
      then GREEN; `unit/voids.test.js` RED (missing module) then GREEN (first run found one wrong
      fixture in the test, no code change); `unit/records.test.js` written with the module (no
      RED); `integration/records-api.test.js` (17) written after the code, its first run found 3
      test defects, no code change. Contract changes in existing tests: archive bodies need
      `reason`; category/kit DELETE need `{reason, confirmName}`; a caja with tools answers 409
      `pending_assignments`; `auth.test` permission list has the 2 new keys.
- [x] E5.T2 Frontend: "Eliminar" actions with motivo sheets (and the assignment resolution
      step for techs/cajas), "Eliminar definitivamente" with typed-name confirmation,
      Administración › Registros eliminados with restore, "Anular" on movements with motivo
      and clear reasons when not possible, "(eliminado)" and "Anulado" marks in history,
      reports and selectors; design guide.
      Commit `432e915`. Route: delegated writer. Code: `features/records/view.js` (delete sheet
      fed by `GET …/delete-check`: blockers, one resolution select per assigned tool plus
      "Devolver todas a disponibles", motivo with quick chips, the purge card only when
      `canPurge`; purge sheet with the typed name; restore sheet; void sheet with the server's
      exact reason and only "Cerrar"; Registros eliminados tab with type filter and search),
      `state/derive.js` (lists and selectors without archived techs, cajas, categories, tools,
      units and kits; `allTechs`/`allCajas`; `voidedBy`; pending returns without voided
      reposiciones), `state/store.js` (name helpers add "(eliminado)"), `ui/components.js`
      (`mvRow`: Anulado chip and strike, Anulación tag with "Anula: …", Anular button), Eliminar
      in the tech, caja and plantilla sheets, líneas rows, config (categories, tool edit, kits,
      especialidades) and admin users; the "Archivadas" chips and sections now point to
      Registros eliminados; reports keep archived techs with controls in the period (marked);
      classes in `v3.css`, no inline styles. `web/test/records.test.js` (2) written with the code.
- [x] E5.T3 E2E: archive and restore each type, archive a tech with tools resolving them in
      the same step, definitive delete only without history (typed name), void an entrega and
      a devolución (inventory reverted, original kept, void cannot be voided, refused when a
      later movement depends), permissions (non-admin refused), `.txt` export tombstones; CI
      green; PR.
      [x] E2E items (route: delegated writer, commit: the `test(e2e)` commit after `432e915`);
      [ ] CI green (pending, parent); [ ] PR (pending, parent). New `t12-eliminar` (7): a tech
      with 2 tools archived from its sheet (pending-choice reason, reparación + retiro, pools,
      hidden from Técnicos, Inactivos and the entrega selector, "(eliminado)" in the movement
      history, restored from Registros eliminados); caja, plantilla, línea, categoría,
      herramienta, kit and especialidad archived in the UI and a user via the API, who/why and
      the type filter, all 8 restored, restore refused when the name is taken; definitive delete
      (no purge with history, wrong typed name refused, purge, server 409 `has_history`, audit
      keeps name and motivo); void an entrega (inventory reverted, original kept with Anulado,
      Anulación without Anular, void of a void refused) and a devolución (the entrega refused
      with the exact reason, devolución voided, assignment active again); responsable sees no
      Eliminar/Anular/tab and gets 403; `.txt` export (archived tech inactive, category and purge
      tombstones, no void pair); every route, Registros eliminados and the delete sheet at 1280
      and 390 without overflow. Adapted: `t3-merge` (category delete is now archive with motivo,
      same 409/428 intent) and `t11-conteo` (línea archive with motivo).
      Evidence (local, sequential): see Stage 5 verification.
- [x] E5.V1 Independent review corrections (route: delegated writer; trigger: 2+ non-trivial
      files across server, migration and web). Test-first, each RED observed before the fix:
      1. `.txt` merge resurrected definitively deleted records: `planImport` now receives the
         server tombstones (`txt-import.js` -> `plan.js`); a tombstoned record absent on the
         server is skipped with conflict "eliminado definitivamente". RED: `unit/txt-plan` (t-borrado
         created) and `records-api` E5.V1 (techs create 1); GREEN after the fix (tech, tool,
         category, user).
      2. Plantilla created with a supervisor -> 500 on purge (23503): any
         `plantilla_supervisor_history` row is history. RED: canPurge true; GREEN: 409 `has_history`.
      3. `DELETE /api/shifts/:id` now needs `records_delete` (optional `{reason}`, still delegates
         to the generic archive); `plantillas_edit` label without "archivar" (server and web); the
         plantilla sheet offers Eliminar with `records_delete` alone. RED: 200 for
         plantillas_edit-only; GREEN: 403.
      4. `controlContext` locks the holder FOR SHARE first (and `saveDraft`/`finalize` lock the
         holder before the control row) and refuses archived holders (409 `archived`). RED (two
         connections): 201 after the archive committed; GREEN: waits, then 409; draft save and
         finalize of an archived tech's draft refused.
      5. Kit items (parent decision): a tool in a kit has history ("Está en un kit."). RED: purge
         allowed (cascade); GREEN: 409 `has_history`, kit item kept.
      6. Archiving a tool locks its kits (sorted by id) before the tool; a kit that adds the tool
         in between gets a 409 `conflict` (retry) instead of an out-of-order lock. RED
         (deterministic two connections): `40P01` between archive and `deliverKit`; GREEN: the
         delivery commits and the archive answers `tool_assigned`.
      7. Migration `013_purge_tech.sql`: `purge_tech_ranges(id)` SECURITY DEFINER (owner) re-checks
         history (`tech_has_history`) and is the only path; the guard needs the marker, the
         function owner as effective user and no history. RED: the app role with `panol.purge`
         deleted t-ana's ranges; GREEN: 23001 (direct and through the function).
      8. `alert_resolutions`: `resolveAlert` takes the tech/caja FOR SHARE (RED: did not wait;
         GREEN: waits for the outside lock). `control_items.tool_id`: no gap — an item only exists
         for an assignment held FOR SHARE by the control, and an assignment is already history of
         the tool (it can never be purged); no extra tool lock (it would invert movements' tool ->
         assignment order).
      Decision (relaxed history): `isHistoryAction` in `domain/records.js` (edits do not count;
      lifecycle actions do). RED: `unit/records` (missing export) and `records-api` (renamed tech
      had "Tiene registros en la auditoría."); GREEN: a renamed tech with no operations is purged
      (its audit rows stay), one with a movement cannot.
      Commits: see Stage 5 verification (E5.V1).

## Stage 5 API notes (for the frontend and later stages)
- Types: techs, cajas, tools, categories, plantillas, lineas, especialidades, kits, users
  (`records_delete`; users also admin only). `GET /api/<type>/:id/delete-check` -> {name,
  version, archived, hasHistory, history[], blockers[{code, message}], assignments[]
  (techs/cajas), canPurge}.
- `POST /api/<type>/:id/archive` {reason, resolutions?: [{assignmentId, action:
  devolucion|retiro, cond?}]} + If-Match -> {<key>, movements[]}; 409 `pending_assignments`
  {pending}; blockers keep their code (`tech_is_referente`, `tool_assigned`, `tool_pending`,
  `category_has_tools`, `plantilla_has_techs`, `last_plantilla`, `linea_has_cajas`,
  `especialidad_in_use`, `especialidad_has_kit`, `kit_base`, `self_deactivate`, `last_admin`);
  `archived`. Techs, tools and users also get `active = false`; a tool's units are archived with
  it and it leaves the kits; archive/restore of tools and categories bump the order scope
  (archived rows are not part of the editable order).
- `POST /api/<type>/:id/restore` {reason} + If-Match; 409 `duplicate` (active name taken),
  `parent_archived` (category, línea or especialidad), `not_archived`. A restored user stays
  inactive. Legajo and unit codes stay unique including archived rows (re-hiring = restore).
- `DELETE /api/<type>/:id` {reason, confirmName} + If-Match: 422 `confirm_name`, 409
  `has_history` {history}. History = movements, controls, assignments, units, plantilla ranges
  beyond the first, rotations or any supervisor history row, kit membership (tools), references,
  or a non-edit lifecycle audit action on the record (E5.V1: an edit no longer counts). Audit
  `<x>_archive|_restore|_delete` with the motivo. The legacy `DELETE /api/shifts/:id` (optional
  `{reason}`) needs `records_delete` (E5.V1), not `plantillas_edit`.
- `GET /api/archived?type&q` -> {records: [{type, id, name, legajo, username, kind, version,
  archivedAt, archivedBy, archivedByName, reason, hasHistory}]} (users only for an admin).
- `POST /api/movements/:id/void` {reason} (Idempotency-Key, `movements_void`) -> 201 {movement
  (type `anulacion`, `voidsMovementId`), voids}; 422 `void_not_possible` with the exact reason;
  `GET /api/movements/:id/void-check` -> {ok, reason}. A recepción is not voidable. State rows
  carry `archived`/`archivedAt`/`archivedBy`/`archiveReason`; movements `voidsMovementId`; users
  `archived`.
- `.txt` v2: archived techs/tools/users exported with active=false; archived categories left out
  and tombstoned in `data.deleted`, as are definitive deletes (from the audit); voids and voided
  originals are not exported. Import: a newer file record never un-archives (conflict reported),
  tombstones of archived rows are no-ops, voided/void ids are not re-created (conflict), and a
  record definitively deleted on the server (its own tombstone) is not re-created (conflict
  "eliminado definitivamente", E5.V1).

## Stage 5 implementation notes
- Lock order kept: order scope -> row (tools, categories); holder FOR UPDATE -> tools by id for an
  archive with resolutions; movements now take the holder FOR SHARE before the tool, so an
  entrega in flight waits for an archive and then sees the holder inactive.
- Void: dependents = later non-voided movements naming its assignments or units (or receiving
  it); pools checked per (tool, pool) except externo; units must still be where the movement left
  them; a void of a demo movement is demo. DB: CHECK type = anulacion ⇔ voids id, unique voids id,
  an insert trigger refuses a void of a void; the ledger stays append-only.
- Tech purge deletes its single creation range only through `purge_tech_ranges(id)` (migration
  013, SECURITY DEFINER of the owner): it re-checks the operational history and the guard accepts
  the DELETE only inside it (effective user = its owner, marker set, no history). The app role
  setting `panol.purge` alone no longer deletes anything (E5.V1).
- Deviations: `.txt` *replace* (initial migration only) and file tombstones of non-archived rows
  keep the stage 1 hard-delete behaviour; archiving does not free legajos or unit codes.

## Stage 5 verification (local, sequential)
- `npm test` 184/184; `npm run test:db` 189/189 (a first full run was 188/1: `auth.test`
  expected the old permission list, a contract change fixed in the test); `npm run build` ok,
  `web/dist/index.html` with 0 inline script/style/handlers; `PANOL_E2E_BUILD=1 npm run
  test:e2e` 60 passed, 0 failed, 0 skipped (451 s). While writing `t12`, two spec defects were
  fixed in the spec (the Inactivos filter left on; a partial devolución without `qty`).
- Base implementation commits: f9b23fa (server), 432e915 (web), edb4702 (E2E); CI run
  42596233444 green (E2E 60/60).
- E5.V1 (2026-11-10, after the interrupted run, delegated verification worker, sequential):
  `npm test` 186/186 (1.1 s); `npm run test:db` 198/198 in 51 suites (417 s);
  `PANOL_E2E_BUILD=1 npm run test:e2e` 60/60 (451 s). Parent spot check: migration 013 read
  (owner-only purge path, history re-check, fixed search_path, no PUBLIC execute).
  Commit: the E5.V1 work-unit commit on `v3/etapa-5-eliminar`.
- Stage 5 PR: #5 → `v3/etapa-4-conteo` after CI.

- Stage 5 closed 2026-11-10: E5.V1 commit `777a13a`, CI run 42905273213 green (unit,
  PostgreSQL, Compose, E2E Chrome), PR #5 → `v3/etapa-4-conteo`. Native gentle-ai review not
  run (diffs of this size stop with `lens_context_budget_exceeded`); the independent read-only
  review that produced E5.V1 is the review of record.

## Stage 6 decisions (parent, within PEDIDO §2.8)
- A novedad is a dated log entry: `occurred_at` set by the server (not editable), author (the
  logged user), comment (required, trimmed, 1–2000 chars), and optional subjects: técnico,
  plantilla, línea (each independent, any combination, all may be empty). Subjects must exist and
  be active when the novedad is created; later archiving keeps the reference (shown with the
  "(eliminado)" mark).
- Links: optional link to one movement of type entrega or reposición (not a void, not a voided
  movement at creation time). The link to a purchase request is added in stage 7 (nullable FK
  column created there) — stage 6 must not invent purchase requests.
- Editing: the author can edit the comment and subjects of their own novedad; `novedades_edit`
  edits any. `occurred_at`, author and creation stay; every edit goes to audit with the previous
  values. Delete = the stage 5 generic records model (new type `novedades`: archive with motivo,
  restore, definitive delete — a novedad has no operational history, so definitive delete is
  allowed with the typed confirmation of its short label).
- Permissions: `novedades_view` (default on for every role, gerencia and consulta included —
  parent decision at the stage 6 review), `novedades_create` (default on for every role that
  operates the pañol), `novedades_edit` (admin by default); `records_delete` governs
  archive/restore/purge.
- List: server-side filters (date range, técnico, plantilla, línea, author, text search, linked
  or not, include archived for `records_delete`), newest first, paginated; live updates through
  the existing SSE channel. The period query is the one stage 10 (impresión) will reuse.
- Entry points: "Nueva novedad" button in the Novedades screen (new nav item), in the tech and
  plantilla sheets (prefilled subject), and "Agregar novedad" on an entrega/reposición row
  (prefilled link and tech). The tech sheet shows its latest novedades.
- Online only, with the existing idempotency keys on create; offline shows a clear message (no
  offline queue in this stage).
- `.txt` v2 has no novedades: they are not exported to nor imported from `.txt` (documented
  deviation). The Excel NOVEDADES import is stage 9.

## Stage 6 tasks (branch `v3/etapa-6-novedades`, stacked on stage 5)
- [x] E6.T1 Backend: migration `014_novedades.sql` (table, indexes for the filters, perms,
      records type), domain validation, application (create/edit/list/filter, link checks under
      lock of the linked movement), HTTP routes, SSE events, audit, generic records integration;
      unit + integration tests (test-first where a RED is meaningful).
      Commit `f13301a`. Route: delegated writer. Code: migration `014_novedades.sql`,
      `domain/novedades.js`, `adapters/pg/novedades-repo.js` (`queryNovedades`: the period query
      stage 10 reuses, also as `application/novedades.js#novedadesOfPeriod`),
      `application/novedades.js`, `adapters/http/novedades-routes.js`; type `novedades` added to
      `domain/records.js` and `application/records.js` (view, history of techs/plantillas/lineas/
      users, Registros eliminados with the comment); `voids.js` takes the same named lock as the
      link; `demo.js` refuses to clear demo data named by a real novedad. Test-first:
      `unit/novedades.test.js` RED (missing module) then GREEN; `unit/permissions` and
      `unit/records` (new keys/type) RED then GREEN; `integration/novedades-api.test.js` (13)
      written after the code (first run: a hook-order defect in the test and one 500 from a
      parameter type mismatch in the insert, fixed in the repo). Contract change: `auth.test`
      permission list has the 3 new keys.
- [x] E6.T2 Frontend: Novedades screen (list, filters, empty states), Nueva/Editar novedad sheet,
      entry points in tech/plantilla sheets and entrega/reposición rows, latest novedades in the
      tech sheet, "(eliminado)" marks, records integration; design guide, classes in `v3.css`.
      Commit `e22a740`. Route: delegated writer. Code: `features/novedades/view.js` (screen with
      filters, cursor "Ver más", sheet, `techNovCard`), `state/novedades.js` (pure helpers),
      `ui/components.js` (`mvRow`: "Agregar novedad"), tech and plantilla sheets ("Nueva
      novedad"; the tech's Novedades tab shows "Novedades registradas" above "Cambios
      detectados"), nav item and Más entry, `api/index.js`, `records/view.js` (type label, gender
      of the toasts, comment in Registros eliminados), `IC.note`, classes `.nov*` in `v3.css`.
      Test-first: `web/test/novedades.test.js` RED (missing module) then GREEN.
- [x] E6.T3 E2E: create with and without subjects, link to an entrega, filter, edit by author
      vs. without permission, archive/restore/definitive delete, live update in a second client.
      Commit `5ae3522`. Route: delegated writer. New `t13-novedades` (3): create with/without
      subjects, link from the entrega row (tech prefilled), tech sheet list, text/tech/link/period
      filters, author edit vs. 403 and no Editar on another user's novedad, admin edit, live
      updates both ways; archive (hidden, "Incluir eliminadas"), restore from Registros
      eliminados, definitive delete with the typed label, consulta without access, responsable
      403 on archive, offline message keeping the text; screen, sheet and tech sheet at 1280 and
      390 without overflow. Written with the code (passed on its first run).
- [x] E6.V1 Review findings. Commit `cca9b59`. Route: delegated writer (2+ non-trivial files).
      (1) PATCH: archived without `records_delete` and someone else's without `novedades_edit`
      answer 404 before the version check — RED: 409 `archived` / 403, GREEN 404 without archived
      fields. (2) `novedadesOfPeriod(db, actor, filters)` in one `withSnapshot`, `queryNovedades`
      `{ withTotal: false }`, archived gated by `records_delete` — RED: old signature returned
      every novedad / no 403, GREEN. (3) `.txt` replace refused with novedades (report error +
      409 `replace_has_novedades`) — RED: `canApply` true, GREEN. (4) Stage 7 notes added.
      (5) New tests (archived tech purge refused in app `has_history` and SQL 23001; cursor
      tie-break on equal `occurred_at` with limit=1; DB UPDATE of author/movement/occurred_at
      23001; PATCH with `authorId`/`movementId` 400) — passed on first run (behavior already
      correct, no RED). (6) `novedades_view` default on for gerencia and consulta — RED in
      `unit/permissions` and `integration/novedades-api`, GREEN; `auth.test` defaults and E2E
      `t13` (consulta sees, cannot create; other's PATCH 404) updated. No web mirror of the
      defaults exists (the web reads them from the server). (7) `novedades` added to E2E
      `ROUTES`.

## Stage 6 implementation notes
- Label for the generic model: `seq` (identity) and a generated `name` = "Novedad N"; it is what
  Registros eliminados shows and what the definitive delete asks to type.
- "Entrega" = `entrega_inicial` and `adicional` (both are entregas) plus `reposicion`.
- Subjects must be active at creation (techs: `active` and not archived); on edit only a changed
  subject is checked, an unchanged archived one is kept. `occurred_at`, author and the movement
  link are fixed (trigger `novedades_fixed_guard`); the link is not editable.
- A novedad naming a tech, plantilla or línea, or written by a user, is history of that record
  (no definitive delete; `tech_has_history` updated in 014). A novedad itself has no history.
- Lock order: named lock `movements.void:<id>` (also taken by `voidMovement`) -> plantilla ->
  tech -> línea (FOR SHARE) -> the novedad. The app role cannot lock `movements` rows (no UPDATE
  grant), hence the named lock.
- Permissions: `novedades_view` default on for every role; `novedades_create` on for responsable
  and supervisor (and admin), off for gerencia and consulta (configurable). Decided by the parent
  at the stage 6 review (E6.V1); first shipped with view off for gerencia/consulta.
- List cursor is built in SQL with microseconds (JS dates would truncate them). Archived only with
  `records_delete` (`archived=include|only`, otherwise 403; GET of an archived one is 404).
  PATCH answers the same 404 (before the version check, so a stale If-Match does not return the
  row) for an archived novedad without `records_delete` and for someone else's novedad without
  `novedades_edit` (E6.V1).
- Live updates: writes `NOTIFY` entity `novedades`; the web's SSE refresh runs the
  `afterState` hook, which reloads the open list or tech card.
- Demo data: clearing it is refused (409 `demo_in_use`) while a novedad names a demo tech or
  movement.
- Deviation: `.txt` v2 has no novedades (not exported or imported); the Excel NOVEDADES import is
  stage 9. `.txt` *replace* is refused while any novedad exists (E6.V1): the
  report shows "Reemplazar es solo para la migración inicial: el servidor ya tiene novedades.
  Usá Combinar." and the apply answers 409 `replace_has_novedades` (before, the report allowed it; by
  code reading, a novedad naming a record the replace deletes then hit the foreign key, mapped
  to the generic 409 `import_conflict`, not a 500).
- `novedadesOfPeriod(db, actor, filters)` contract (for stage 10): `filters` are the ones of
  `GET /api/novedades` (from, to, techId, plantillaId, lineaId, authorId, movementId, q, linked,
  archived); it returns every matching novedad (API shape, newest first) paging 200 at a time
  with `queryNovedades(..., { withTotal: false })` inside one REPEATABLE READ read-only
  transaction (`withSnapshot`), so a concurrent write is neither repeated nor skipped.
  `archived=include|only` requires `records_delete` (else 403); the caller checks its own
  permission (e.g. printing) — the function does not require `novedades_view`.

## Stage 7 notes (from stage 6)
- The list `linked` filter (`linked=yes|no`, now `movement_id IS [NOT] NULL`) must also consider
  the purchase-request link once that column exists (linked = movement or purchase request).
- `novedadesOfPeriod` contract: see the stage 6 implementation notes (actor-gated archived
  inclusion, snapshot, no total); keep it when adding the purchase-request link.

## Stage 6 verification (local, sequential, delegated writer)
- `npm test` 198/198; `npm run test:db` 211/211 (446 s; server code of `f13301a`, unchanged
  after); `npm run build` ok; `PANOL_E2E_BUILD=1 npm run test:e2e` 63 passed, 0 failed, 0
  skipped (479 s).
- Commits: `f13301a` (server), `e22a740` (web), `5ae3522` (E2E), then this doc commit.
- E6.V1 (`cca9b59`): `npm test` 198/198; `npm run test:db` 214/214 (435 s); `npm run build` ok;
  `PANOL_E2E_BUILD=1 npm run test:e2e` 63 passed, 0 failed, 0 skipped (483 s).

- Stage 6 closed 2026-11-10: CI run 42920051070 green, PR #6 → `v3/etapa-5-eliminar`.

## Stage 7 decisions (parent, within PEDIDO §2.7 and the user's decisions of 2026-11-07)
- Purchase request (`purchase_requests`): number (shown as "Compra N"), tool, unit (when the
  tool is unit-tracked), assignment when it comes from a holder, holder (técnico or caja) and its
  plantilla as a snapshot at creation, reason `cambio` (dañada) or `faltante` (extraviada), the
  control observation (snapshot), qty (> 0), optional estimated cost (ARS, numeric(12,2)) and
  supplier, origin (`control`, `tool`, `alert`), created_by/created_at, status, version.
- States: `pendiente` → `aprobada` | `rechazada`; `aprobada` → `comprada` (optional step) →
  `recibida` (also `aprobada` → `recibida` directly). Decide = any user with
  `purchases_decide`; one approval is enough; reject requires a comment; who/when is stored for
  every transition. Rejected and received requests are closed and stay in history.
- Automatic creation: when a control is finalized (or corrected), every item with a faltante or
  cambio quantity creates a request unless an OPEN request (pendiente/aprobada/comprada) exists
  for the same assignment (or unit) and reason; then the control is linked to it (link table
  request ↔ control) and, while pendiente, its qty follows the latest effective control. Dedupe
  is by assignment/unit + reason, NEVER by alert key (stage 4 note). The creator of an automatic
  request is the user who finalized the control.
- A correction that removes the loss: a pendiente request whose only source is the superseded
  control is archived automatically with motivo "Corregido en el control"; approved or later
  requests are never touched automatically.
- After a rejection, no new automatic request opens for the same assignment/unit + reason until
  a control shows that loss resolved; the alert stays visible as "compra rechazada" with the
  reason (user decision). Manual creation is always possible.
- Manual creation from the tool sheet and from a faltante/cambio alert (prefilled), with
  `purchases_create` (responsable, supervisor, admin by default).
- Reception (`purchases_receive`: responsable, admin): marks `recibida` and, in the same
  transaction, creates the inventory ingreso movement (existing ingreso/alta type, or a new
  `ingreso_compra` if none fits) linked to the request; a later reposición to the holder can be
  linked to that ingreso (the reposición form offers received requests of that holder). Locks:
  request FOR UPDATE, then the existing movement lock order.
- Cancel = the stage 5 records model, type `compras`, archive/restore only while `pendiente`; no
  definitive delete (requests are history).
- Gerencia section (`purchases_view`: gerencia, admin): inbox of pendientes with quick approve
  from the phone (one tap + confirm) and reject with comment; filters (status, month, plantilla,
  técnico/caja, tool, reason); monthly totals of approved (count and sum of known estimated
  costs; unknown costs counted apart); nav badge with the pending count and an alert
  "compras pendientes" for users with `purchases_decide`. Responsables see the status of a
  request on the tool sheet / alert and a "Compras a recibir" list for `purchases_receive`.
- Novedades: nullable `purchase_request_id` link; `linked` filter = movement OR purchase
  request; the novedad sheet can link a request; keep the `novedadesOfPeriod` contract.
- Stage 10 query: `purchasesOfPeriod(db, actor, filters)` (approved and rejected in the period,
  one REPEATABLE READ snapshot), like `novedadesOfPeriod`.
- `.txt` v2 has no purchases: not exported/imported (documented deviation); `.txt` replace is
  refused once requests exist (like novedades).
- Audit, SSE refresh, idempotency keys on create/decide/receive, If-Match versions on every
  transition, as in earlier stages.
- E7.V1 (parent decisions after the review): marking `comprada` is allowed to whoever decides
  (`purchases_decide`) or receives (`purchases_receive`), but only `purchases_decide` changes the
  estimated cost or the supplier once the request is no longer `pendiente` (API 403 and a DB
  guard). Costs and suppliers are visible only with `purchases_view`. A later effective control of
  the same holder (same assignment) that no longer shows the loss marks a `pendiente` request with
  `loss_resolved_at` — it is NOT cancelled — and the inbox, detail and approve sheet show "La
  pérdida ya no figura en el último control"; a later control showing the loss again clears it.

## Stage 7 tasks (branch `v3/etapa-7-gerencia`, stacked on stage 6)
- [x] E7.T1 Backend: migration `015_compras.sql` (requests, request↔control links, ingreso link,
      novedad link column, perms, records type), domain (state machine, dedupe, qty rules),
      application (auto creation in finalize/correct, manual create, decide, purchase, receive
      with ingreso, cancel, lists/filters/totals, period query), routes, SSE, audit; unit +
      integration tests (test-first where a RED is meaningful).
      Commit `40bdc9b`. Route: delegated writer. Code: migration `015_compras.sql`,
      `domain/compras.js` (states, `checkTransition`, `cleanCost`, `cleanManualPurchase`,
      `lossesOf`, `countedPairs`, `sameKey`, `planAutoPurchases`, `parsePurchaseFilters`),
      `adapters/pg/compras-repo.js` (`lockCandidates`, `queryPurchases`, `purchaseTotals`,
      `loadPurchaseSummary`, `queryDecidedPage`), `application/compras.js`
      (`autoPurchasesOnFinalize` called from `controls.js#finalizeControl`, `createPurchase`,
      `transitionPurchase`, `updatePurchase`, `checkReposicionLink`/`linkReposicion` called from
      `movements.js#registerMovement`, `listPurchases`, `getPurchaseDetail`, `purchaseTotals`,
      `purchasesOfPeriod`), `adapters/http/compras-routes.js`; records type `compras`
      (`domain/records.js`, `application/records.js`: blocker `purchase_not_pending`, always
      history, restore refused with another open request); novedades `purchaseRequestId`;
      `/api/state` `purchases` summary and `purchase` on faltante/cambio alerts; `.txt` replace
      refusal; demo-clear guard. Test-first: `unit/compras.test.js` RED (missing module) then
      GREEN; `unit/permissions` RED (2 failures: new keys/defaults) then GREEN.
      `integration/compras-api.test.js` (19) written with the code: passed on its first run
      except the DB-guard test it gained afterwards, which was RED for a real defect (the
      `rechazada` CHECK accepted a NULL comment: `length(trim(NULL))` is NULL) -> CHECK fixed in
      015 -> GREEN. Contract changes in existing tests: `unit/novedades` filters have
      `purchaseRequestId`, `unit/records` type list has `compras`, `auth.test` gerencia
      permissions, `web/test/constants` mirror (`web/src/state/constants.js`). New
      `txt-import` test: replace refused with `replace_has_purchases`.
- [x] E7.T2 Frontend: Gerencia section (inbox, quick approve, reject sheet, filters, monthly
      totals, badge, alert), request detail with timeline, manual create from tool sheet/alert,
      "Compras a recibir" + receive sheet, reposición link to a received request, status on tool
      sheet/alert ("compra rechazada"), novedad link; design guide, classes in `v3.css`.
      Commit `d2f986e`. Route: delegated writer. Code: `features/compras/view.js` (`#compras`
      tabs Pendientes / Todas / Totales por mes / A recibir by permission; quick approve sheet,
      reject sheet with chips, purchase and receive sheets, edit sheet; `#compra-<id>` detail with
      data, decision/purchase/reception, linked controls, novedades, timeline; `openCompraNew`
      from the tool sheet and from alerts; `toolComprasCard`), `state/compras.js` (pure),
      `ui/components.js` (`alertRow`: purchase chip, "Solicitar compra"), `alertas/view.js`
      ("compras pendientes" banner for `purchases_decide`), `entregas/view.js` (reposición
      select of received requests), `novedades/view.js` (purchase select/chip, linked label),
      `inventario/view.js` (tool sheet card), nav entry + badge (`ui/app.js`, `ui/router.js`),
      Más group, `records/view.js` label, `IC.cart`, `.cmp*`/`.alcmp` classes in `v3.css`.
      Test-first: `web/test/compras.test.js` RED (missing module) then GREEN.
- [x] E7.T3 E2E: control with faltante → automatic request (and no duplicate on a second control
      or a correction), approve on 390 px, reject with comment → "compra rechazada" alert,
      receive → ingreso, reposición linked, gerencia vs. responsable permissions, totals.
      Commit `62f013b`. Route: delegated writer. New `t14-compras` (2): automatic requests from
      a control and none on a correction; Gerencia at 390 px: "compras pendientes" banner, inbox,
      44 px approve target, one tap + confirm, reject needs a comment; totals KPIs; responsable
      sees "compra rechazada" with the reason and "Solicitar compra"; A recibir only for the
      responsable, receive with codes -> ingreso and unit AM-9 available; reposición linked from
      the entregas form; manual requests from the tool sheet (cost `1500,50`) and from the
      rejected alert; novedad linked from the detail; consulta without nav/access; Gerencia nav
      badge; detail, inbox, reject sheet and Todas at 1280 and 390 without overflow. `compras`
      added to E2E `ROUTES`. Written with the code; first run found one spec defect (expected 5
      rows, there are 4), fixed in the spec.
- [x] E7.V1 Review fixes. Route: delegated writer (one bounded writer; server + web + tests).
      Commit `71c23a6`. Fixes and evidence:
      1. Cost/supplier after the decision only with `purchases_decide` (PATCH and `purchase` 403;
         trigger guard with `panol.purchase_decider`). RED: responsable PATCH on aprobada 200≠403
         (`compras-review`), then GREEN; existing test updated (responsable `purchase` with cost
         is now 403; Gerencia sets cost by PATCH).
      2. Costs only with `purchases_view` (detail, lists, `scope=receive`, responses, audit text cut
         at `COST_MARK`; web hides rows/fields). RED: `estimatedCost` present for responsable;
         unit `stripCosts/stripCostText` RED (missing exports), then GREEN.
      3. `/api/state` received set: with assignment and received in the last 90 days. RED: a
         request received 100 days ago still listed, then GREEN.
      4. Reposición link: same assignment (and unit); stock requests not linkable nor offered
         (`receivableFor(summary, asgId)`). RED: reposición on another assignment of the same
         holder linked (201), then GREEN; web unit test RED (missing export), then GREEN.
      5. `.txt` merge: deletion of a record named by a purchase request or novedad is a conflict
         (`ledger.refs`). RED: 409 `import_conflict` (FK) with plan.js stashed, then GREEN.
      6. Restore of `compras`: 409 `assignment_inactive`; duplicate stays 409 `duplicate` (also on
         23505); advisory lock before the row lock. RED: restore 200≠409, then GREEN.
      7. Pendiente marked when the newest control no longer shows the loss (`loss_resolved_at`,
         audit `purchase_loss_gone`/`purchase_loss_back`); web chip/banner "La pérdida ya no figura
         en el último control" (`lossGoneNote`). RED: unit plan test and integration
         `loss_resolved_control_id` null, then GREEN.
      8. Missing tests: receive replay with the same Idempotency-Key (one ingreso, stock
         unchanged), `clearDemo` refused with a purchase on demo data, unit-key dedupe after the
         unit moved to another holder's assignment — all passed on first run (behavior was
         already correct; no RED).
      9. Doc: parent decisions recorded in "Stage 7 decisions" and the implementation notes.

## Stage 7 implementation notes
- API: `GET /api/compras` (filters `status` (a state or `open`), `month` (local month of the
  creation), `plantillaId`, `techId`, `cajaId`, `toolId`, `reason`, `q`, `archived`, `scope=receive`,
  `limit`, `before` cursor built in SQL with microseconds); `GET /api/compras/totals?from&to`
  (months, default the last 6; approved per month of the decision: count, known-cost sum, count
  without cost, rejected; plus `pending`); `GET /api/compras/:id` (+ `controls`, `timeline` from
  the audit, `novedades`); `POST /api/compras`; `PATCH /api/compras/:id` (cost, supplier,
  observation while open; qty only while pendiente); `POST /api/compras/:id/approve|reject|
  purchase|receive` (If-Match + Idempotency-Key). Records: `/api/compras/:id/archive|restore|
  delete-check` (DELETE always 409 `has_history`). `POST /api/movements` accepts
  `purchaseRequestId` on a reposición. `POST /api/novedades` accepts `purchaseRequestId`
  (fixed after creation, like the movement link); `GET /api/novedades` filters by it and
  `linked=yes|no` = movement OR purchase request. Costs are numbers in the API, `numeric(12,2)`
  in the DB; `estimatedCost` accepts a number or a decimal string.
- Permissions (parent decision followed): `purchases_view` and `purchases_decide` for gerencia
  (+admin); `purchases_create` for responsable and supervisor; `purchases_receive` for the
  responsable only — so supervisor = responsable + `shift_change` − `purchases_receive` (the
  unit test invariant was updated accordingly). Marking `comprada` is allowed to
  `purchases_decide` or `purchases_receive` (writer decision, confirmed by the parent in E7.V1);
  with only `purchases_receive` the `purchase` body cannot carry `estimatedCost`/`supplier` (403).
  The full list needs `purchases_view`; with only `purchases_receive`, `scope=receive` (aprobada
  and comprada). The detail is readable with view, receive or create (the responsable sees the
  status from the tool sheet and alerts through the `/api/state` summary, without costs).
- Automatic creation runs inside `finalizeControl` (originals and corrections) after the control
  is rewritten: every counted item with missing units -> reason `faltante`, with units for
  change -> `cambio` (both can exist); dedupe by assignment (or unit) + reason, never by alert
  key. Lock order: holder FOR SHARE -> control -> assignments FOR SHARE -> advisory lock
  `purchases.asg:<assignment>` (sorted, only assignments with a loss) -> candidate requests FOR
  UPDATE (by id). Manual creation takes holder -> assignment -> the same advisory lock. The
  partial unique indexes (assignment+reason, unit+reason over open, non-archived requests) are
  the backstop. Concurrency proven deterministically: two finalizes waiting on the held lock
  produce one request linked to both controls.
- Quantity: a pendiente request follows the newest effective control: it is updated only when the
  finalizing control's period is >= the newest period already linked (correcting an older period
  links without changing the qty). An approved or later request is only linked.
- Correction that removes the loss: a pendiente, origin `control` request linked to the
  superseded control whose linked controls are all of that same holder and period is archived
  with "Corregido en el control" (actor = who finalized). With a control of another period
  linked, it is left untouched (writer decision: "only source" = same holder+period chain).
  A later ordinary control without the loss leaves an open request open (cancel by hand); since
  E7.V1 a `pendiente` one is marked (`loss_resolved_at`/`loss_resolved_control_id`, audit
  `purchase_loss_gone`) when the control is the newest of the request (period >= the newest
  linked) and names the same assignment; the mark is cleared (`purchase_loss_back`) by a control as
  new showing the loss again. Approved or later requests are not marked.
- Rejection: `loss_resolved_at` / `loss_resolved_control_id` on the rejected request are set by
  the first finalized control whose item for that assignment+reason has no loss; until then the
  automatic creation is blocked (`blocked` in the plan), the alert keeps `purchase` =
  rechazada with the comment. Manual creation is always possible (409 `purchase_exists` only
  while another request is open for the same key).
- Reception: request FOR UPDATE -> `applyMovement` (`ingreso`, tool FOR UPDATE, `units.code`
  lock); serialized tools need one code per received unit (qty = codes); the ingreso id is
  stored on the request. Reposición link: checked before the movement (no lock), then the
  request FOR UPDATE after the movement (order movement -> request), same tool, same holder and
  (E7.V1) the same assignment — and the same unit when the request names one; a stock request
  (no assignment) is not linkable nor offered in the reposición selector; only once (unique index).
  The `/api/state` summary lists received requests without reposición only when they have an
  assignment and were received in the last 90 days.
- DB guards: trigger `purchase_requests_guard` (valid transitions only; origin fields, decisions,
  receptions and the reposición link are fixed once written; closed requests keep qty/cost/
  supplier; E7.V1: after `pendiente`, cost/supplier change only in a transaction marked
  `panol.purchase_decider = on`, which the app sets only for `purchases_decide`); CHECKs for each
  state; the app role has no DELETE on the purchase tables.
- Costs (E7.V1): without `purchases_view` the API omits `estimatedCost` and `supplier` (detail,
  lists including `scope=receive`, create/transition/edit responses), the text search skips the
  supplier, and audit details are cut at the marker ". Costo y proveedor: " (cost and supplier are
  always written last, so a cut never leaks them). `/api/state` and alert enrichment never had
  them. The web detail hides those rows, and the purchase/edit sheets hide the fields, unless the
  user may see/edit them (`cmpActions(...).cost`).
- Restore of `compras` (E7.V1): refused 409 `assignment_inactive` when the assignment or its
  holder is no longer active; another open request for the same key is 409 `duplicate` (also when
  the partial unique index fires); the assignment advisory lock is taken before the row lock.
- History: a purchase request is history of its tool, tech, caja, plantilla and users (records
  `HISTORY`, `tech_has_history` redefined in 015). Existing finalized controls are NOT
  backfilled into requests (requests start with stage 7).
- Deviation: `.txt` v2 has no purchases (not exported/imported); replace is refused once any
  request exists (report error + 409 `replace_has_purchases`). E7.V1: a merge deletion of a
  record named by a purchase request (tool, unit, assignment, tech, users, controls) or a novedad
  (tech, users) is a reported conflict and the record is kept (`ledger.refs` in `txt-repo.js`,
  checked in `plan.js`), instead of the FK error.
- UI: Spanish copy, status chips with icon + text + color; quick approve and reject buttons are
  44 px targets and wrap at 390 px; no inline styles in the new code (classes `.cmp*`).
- Size: the backend work unit is ~1.7k authored lines (migration, domain, application, repo,
  routes and ~600 lines of tests) — one inseparable behavior (automatic creation needs the
  schema, state machine and locking together); not split artificially.
- `purchasesOfPeriod(db, actor, filters)` (stage 10): `filters` = `from`, `to` (local days of the
  decision), `plantillaId`, `techId`, `cajaId`, `toolId`, `reason`; returns approved (also
  comprada/recibida) and rejected requests, oldest decision first, paging 200 inside one
  `withSnapshot`; the caller checks its own permission.

## Stage 7 verification (local, sequential, delegated writer)
- On `62f013b` (all three work units): `npm test` 215/215; `npm run test:db` 234/234 (549 s);
  `npm run build` ok; `PANOL_E2E_BUILD=1 npm run test:e2e` 65 passed, 0 failed, 0 skipped
  (519 s). An earlier `test:db` run on the same server code was also 234/234 (491 s).
- Commits: `40bdc9b` (server), `d2f986e` (web), `62f013b` (E2E), then this doc commit. Not pushed.
- E7.V1 (`71c23a6`): `npm test` 218/218; `npm run test:db` 244/244 (514 s); `npm run build` ok;
  `PANOL_E2E_BUILD=1 npm run test:e2e` 65 passed, 0 failed, 0 skipped (514 s). Not pushed.

- Stage 7 closed 2026-11-11: E7.V1 `71c23a6`, CI run 42965378623 green, PR #7 →
  `v3/etapa-6-novedades`.

## Stage 8 decisions (parent, within PEDIDO §2.9)
- Existencia screen (new nav item "Existencia", visible to every role that can see reports,
  gerencia included — user decision: gerencia has read-only stock per tech): equivalent of the
  Excel RESUMEN. Rows = non-archived tools in the custom order of stage 3 (N° + name: tools have
  no code; unit codes of each holder where the tool is tracked by unit, in the cell title and in
  the Excel cell; deactivated tools still assigned are marked "(inactiva)"); columns = the
  holders (técnicos and cajas) of the selected plantilla (filter: plantilla, or all; toggles
  "incluir cajas" and "solo con herramientas"), each column header with legajo/name,
  especialidad, last effective control date and days since it.
- Cell = assigned quantity of that tool to that holder; when the holder's latest effective
  control reports recambio or faltante for it, the cell shows the marks (C n / F n) with symbols
  and color (legible in black and white). Per row: total assigned, total recambio, total
  faltante, and pañol stock (available). Per column: total assigned, recambio, faltante. Grand
  totals. Archived holders/tools excluded (they are history).
- One pure domain function builds the matrix (server `domain/` + the web uses the same rules as
  the reports do), tested in Node; the screen derives it from `/api/state` like the reports. Large
  plantillas: sticky first column and header, horizontal scroll inside the table only (no page
  overflow at 390 px).
- Export to Excel with the existing self-hosted `xlsx` (same pattern as `reportes/export.js`),
  same rows/columns/totals plus a legend; print with a print stylesheet (landscape, repeated
  header, symbols + legend at the foot), `reports_export` permission for both, as reports.
- Days since the last effective control: shown in the tech and caja sheets, in plantilla member
  lists and in the Existencia header; holders with active assignments and no control show
  "Sin controles" (days counted from their first active assignment). "Overdue" on screen follows
  the alert rule: a holder with no active assignments is never overdue (days still shown, neutral
  tone).
- Alert "Sin control hace N días": per holder with active assignments whose last effective
  control is older than the threshold (or never, counted from the first active assignment).
  Threshold configurable in Administración (company settings), default 14 days, 0 disables it;
  needs the existing settings permission. The alert key includes the last control id so it
  resolves by itself with a new control; resolutions follow the existing alert model.
- No new tables beyond the setting (migration `016_existencia.sql` only if the settings store
  needs a column/row); `.txt` v2 unaffected.

## Stage 8 tasks (branch `v3/etapa-8-existencia`, stacked on stage 7)
- [x] E8.T1 Domain/back: matrix builder + days-since helper (pure, unit-tested), alert rule with
      configurable threshold (server alerts + setting + migration if needed), any API the screen
      needs; unit + integration tests (test-first where a RED is meaningful).
      Commit `53eef77`. Route: delegated writer. Code: `domain/existencia.js` (`localDaysSince`,
      `cleanOverdueDays`, `isOverdue`, `lastControlByHolder`, `firstActiveSince`, `controlAge`,
      `buildExistencia`), `domain/alerts.js` (`sin_control` rule, `controlOverdueDays` input),
      `adapters/pg/settings-repo.js`, `application/settings.js`, `adapters/http/settings-routes.js`
      (`GET`/`PUT /api/settings/alerts`), `state-repo.js` (`settings`), `application/read.js`
      (`getExistencia`, threshold passed to the alerts), `application/alerts.js` (resolve uses the
      same threshold), `read-routes.js` (`GET /api/existencia`). No migration (the `app_settings`
      table already exists; no row = default 14). Test-first: `unit/existencia.test.js` (6) RED
      (missing module) then GREEN; `integration/existencia-api.test.js` (7) RED (7 failures: no
      routes, no alert) then GREEN; one wrong expectation in the test itself fixed (error code is
      in `error`, not `code`).
- [x] E8.T2 Frontend: Existencia screen (filters, sticky matrix, marks, totals), Excel export,
      print stylesheet, days-since in sheets/plantillas, threshold setting in Administración,
      alert rendering; design guide, classes in `v3.css`.
      Commit `6f68b20`. Route: delegated writer. Code: `state/existencia.js` (pure mirror of the
      server rules with the Buenos Aires date, labels/tones, `existenciaSheet` rows + legend),
      `features/existencia/view.js` (`#existencia`: plantilla select, "Incluir cajas" / "Solo con
      herramientas" chips, KPIs, matrix in `#exiwrap` with sticky header and first column, C/F marks
      with letter + number + color, row/column/grand totals and pañol stock, legend; Excel via the
      self-hosted xlsx; "Imprimir" with `body.print-exi` + `@media print` A4 landscape, repeated
      header, black and white), `ui/components.js` (`ageChip`, alert icon/"Controlar" for
      `sin_control`), tech/caja sheets and plantilla member cards (`ageChip`), Administración ›
      Configuración card "Alerta de días sin control" (If-Match, 0–365), Alertas KPI "Sin control",
      nav + Más entry, `IC.grid`/`IC.print`, `.exi*`/`.ctlage`/`.cfg*` in `v3.css`.
      Test-first: `web/test/existencia.test.js` (5) RED (missing module) then GREEN.
- [x] E8.T3 E2E: matrix values after entregas and a control with recambio/faltante, plantilla
      filter, export file produced, print view renders, days-since and the alert crossing a
      threshold changed in Administración, 390 px without page overflow.
      Commit `bdf6492`. Route: delegated writer. New `t15-existencia` (3): matrix cells/marks/totals
      (recambio not missing, unit-tracked tool, caja column, pañol stock) and API parity; plantilla
      filter, cajas and "solo con herramientas" toggles; xlsx file (zip, >2 KB); print (window.print
      called, print media hides the chrome, company header, repeated thead, black marks, legend);
      alert at the default 14 days for a tech whose first entrega was backdated 20 days, gone at 30
      and back at 10 set in Administración, out-of-range refused; days in tech/caja sheets and the
      plantilla member card; 390 px without page overflow, matrix scrolls in its box with sticky
      header/first column; gerencia opens it (403 on the threshold), responsable sees the value
      read-only. `existencia` added to E2E `ROUTES`. Written with the code (passed on its first run).
- [x] E8.V1 Review fixes. Route: delegated writer (one bounded writer, server + web + tests + doc).
      Commit `9a8e1b4`. Shared fixture `server/test/fixtures/existencia.js`
      (`fixture`, `reviewFixture`) used by the server unit test and the web parity test.
      (1) Overdue = alert rule (no active assignments -> never overdue, tone `idle`, days shown):
      `holderOverdue`, holders carry `active`/`overdue`, KPI/header/`ageChip` use it. RED: server
      unit (no `overdue`/`active`), web unit (`ageTone` 'ok'/'bad' for Dora) -> GREEN.
      (2) Web control date falls back to the start of its week (Buenos Aires midnight) like the
      server; parity test runs both builders on the same fixtures (2 fixtures x 3 filters x 2
      thresholds, deepEqual). RED: web parity + "sin fecha de finalización" -> GREEN.
      (3) Tools filtered on archived only, `inactive` row flag, "(inactiva)" label (screen + Excel).
      RED: server + web -> GREEN. (4) Unit codes per cell (`codes`): cell `title` + hidden text, Excel
      cell `n (C · F) [TAL-1, TAL-2]`, legend lines. RED: server + web -> GREEN; E2E t15 updated
      (cell text, title, API `codes`). (5) Doc notes (implementation notes, E8.V1). (6) Tests: resolved
      `…-nunca` after a later first delivery stays hidden until a control (unit; passes on the old
      code: documents existing behaviour); `/api/existencia?cajas=0&withTools=1` overdue holders =
      tech `sin_control` alerts (integration; RED on the pre-fix server code, 1 failure -> GREEN).

## Stage 8 implementation notes
- API: `GET /api/existencia?plantilla=<id>&cajas=0|1&withTools=0|1` (any session, like
  `/api/reports`) -> {now, controlOverdueDays, filters, holders [{key, kind, id, name, legajo,
  especialidad, plantillaId, lastControlId, lastControlAt, never, from, days, total, cambio,
  faltante}], rows [{toolId, n, name, categoryId, cells {holderKey: {qty, cambio, faltante}},
  total, cambio, faltante, disponible}], totals}. `GET /api/settings/alerts` (any session) and
  `PUT` {controlOverdueDays} + If-Match (409 stale, 422 `invalid_setting` outside 0–365, 400 non
  integer); audit `alert_settings`. `/api/state` adds `settings: {controlOverdueDays}`.
- "Last control" = the holder's latest effective control (highest period, then finish time — a
  correction replaces its period); its date is `finishedAt`. "Days since" = local calendar days
  (Buenos Aires) between that date and today; never controlled -> from the earliest `since` of
  its active assignments; no assignments and no control -> null ("Sin controles").
- Cell marks: `asgUnits(item of the latest control, qty)` per active assignment (same rule as the
  reports: if the assigned qty changed since the control, the item state applies to all units);
  an assignment delivered after that control has no marks. Unit-tracked tools add one per unit.
- Writer decisions (consistent with stages 1–7): (1) the threshold is edited with
  `plantillas_edit` (the permission of the existing Administración › Configuración setting, admin
  by default) — there is no separate settings permission; (2) "Incluir cajas" adds every active
  caja regardless of the plantilla filter (cajas belong to líneas, not plantillas), on by default;
  (3) tools have no code field, so rows show their position in the custom order (N°) and name;
  (4) holders: active techs by name, then active cajas by name; (5) the alert is `sin_control`,
  sev 2, key `sinctl-<holderKey>-<lastControlId|nunca>`, title "Sin control hace N días", only for
  active holders with active assignments and days > threshold; (6) the print stylesheet is
  scoped to `body.print-exi` (set by "Imprimir", removed on `afterprint`); `@page` A4 landscape
  applies to any print (stage 10 may refine it).
- `.txt` v2 unaffected (`app_settings` is not exported). No new migration.
- E8.V1 review notes: (a) a resolved `sin_control` alert stays hidden until a new effective
  control changes its key, consistent with the key-based resolution model (accepted by the
  parent); for a never-controlled holder the key is `…-nunca`, so a resolution also covers a later
  new first delivery until the first control (pinned in `unit/existencia.test.js`). (b) Stage 10:
  `@page{size:A4 landscape}` is global today; stage 10 must scope print page settings (named
  `@page` / per print class) and handle Ctrl+P outside the print buttons. (c) Unit codes: kept in
  the cell (`codes`), shown as the cell `title` + hidden text on screen and as `[TAL-1, TAL-2]`
  after the quantity/marks in the Excel cell (no extra columns, the matrix stays readable).
  (d) Tools filter on archived only; `inactive` marks the row. (e) The control date falls back to
  the start of its week when `finishedAt` is missing on both sides; holders carry `active`
  (active assignments, any tool) and `overdue` (builder option `threshold`).

## Stage 8 verification (local, sequential, delegated writer)
- On `bdf6492` (all three work units): `npm test` 229/229; `npm run test:db` 251/251 (542 s;
  also 251/251 on `53eef77`, 551 s); `npm run build` ok; `PANOL_E2E_BUILD=1 npm run test:e2e`
  67 passed, 1 failed: `t9-plantillas` "every route … without overflow" — `#existencia overflows
  at 1280: 1320 > 1280` with the demo data (the visually hidden `.exi-sr` labels, absolutely
  positioned without a positioned ancestor inside the scroll box, escaped it). Fixed in
  `2998411` (`fix(web): keep hidden matrix labels inside the scroll box`: `.exiwrap` is
  `position:relative`); that spec alone then passed.
- On `2998411` (CSS-only change after the `test:db` run): `npm test` 229/229; `npm run build` ok;
  `PANOL_E2E_BUILD=1 npm run test:e2e` 68 passed, 0 failed, 0 skipped (538 s).
- Commits: `53eef77` (server), `6f68b20` (web), `bdf6492` (E2E), `2998411` (fix), then this doc
  commit. Not pushed.
- E8.V1 (`9a8e1b4`, review fixes): `npm test` 238/238; `npm run test:db` 252/252 (579 s, on the
  commit); `npm run build` ok; `PANOL_E2E_BUILD=1 npm run test:e2e` 68 passed, 0 failed, 0 skipped
  (562 s; first runs failed only in `t15-existencia`, whose cell text and API cell assertions
  predated the unit `codes` — spec updated). Not pushed.

## Next step
- Stage 8: independent review, CI and PR #8 → `v3/etapa-7-gerencia`.
- PRs #1–#7 await user review (stacked: #1 → `v3-servidor`, each next PR → the previous stage). Engram mirror of this document: pending (multiple active
  sessions). PR #1 awaits user review; after it is merged, rebase stage 2 onto `v3-servidor`.
- Follow-ups: periodic cleanup of expired sessions, old login attempts and idempotency
  keys; SSE does not re-check the session after it is opened (closes on reconnect only);
  `/api/state` and movement planning load the full ledger (fine for stage 1 volumes);
  `.env.example` still lacks the deploy variables (documented in LEEME); remote retention of
  off-VPS copies is a bucket lifecycle rule (rclone copy, not sync).

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
1. Servidor, usuarios y migración desde el `.txt` — in progress (`v3/etapa-1-servidor`)
2. Plantillas, movimiento de técnicos y líneas
3. Especialidad, kit base y orden
4. Conteo por cantidad y limpieza
5. Eliminar y anular
6. Novedades
7. Gerencia
8. Existencia por técnico y alertas
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

## Next step
- Stage 2 PR (stacked on PR #1). Engram mirror of this document: pending (multiple active
  sessions). PR #1 awaits user review; after it is merged, rebase stage 2 onto `v3-servidor`.
- Follow-ups: periodic cleanup of expired sessions, old login attempts and idempotency
  keys; SSE does not re-check the session after it is opened (closes on reconnect only);
  `/api/state` and movement planning load the full ledger (fine for stage 1 volumes);
  `.env.example` still lacks the deploy variables (documented in LEEME); remote retention of
  off-VPS copies is a bucket lifecycle rule (rclone copy, not sync).

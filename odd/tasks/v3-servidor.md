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
- [ ] E1.T7 E2E: runner starts the server on a seeded embedded DB; the 30 existing specs
      adapted; new specs for login, lockout, forced password change, `.txt` migration,
      conflict 409, offline draft.
- [ ] E1.T8 Deploy and CI: `Dockerfile`, `docker-compose.yml` (app, `postgres:16.x`, caddy
      with automatic HTTPS, backup with rotation + optional rclone off-VPS copy),
      restore script tested in CI, `LEEME.md` install/update/restore; GitHub Actions on push
      and PR to `v3-servidor` and `v3/**`: unit, integration (`postgres:16`), compose build +
      up + `/api/health` smoke + down, E2E.
- [ ] E1.T9 Close stage 1: CI green, PR `v3/etapa-1-servidor` -> `v3-servidor` with what was
      done, how to test and test results.

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

## Next step
- E1.T7 E2E on the server.
- Follow-ups: periodic cleanup of expired sessions, old login attempts and idempotency
  keys; SSE does not re-check the session after it is opened (closes on reconnect only);
  `/api/state` and movement planning load the full ledger (fine for stage 1 volumes);
  generate the Compose `postgres` tag from `server/pg-version.json` in E1.T8.

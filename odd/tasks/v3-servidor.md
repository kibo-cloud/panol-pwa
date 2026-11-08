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
- [ ] E1.T5 `.txt` v2 importer and export: admin-only; same validation as 2.1 plus the empty
      date rule; `data.deleted` applied; PIN users migrated (PIN works once as temporary
      password, then forced change); import report before confirming; *Descargar .txt*.
- [ ] E1.T6 Frontend on Vite: split `index.html` into feature modules, API client replaces
      `S`/`put`/`patch`/`del`, login with user + password + "Mantener la sesión", forced
      password change, live updates via SSE, conflict notice on 409, offline banner + local
      draft of the control in progress resent on reconnect, CSP `script-src 'self'`, xlsx and
      jspdf self-hosted with SRI, service worker updated. Same views and design.
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

## Next step
- E1.T5 `.txt` v2 importer and export.
- Follow-ups: periodic cleanup of expired sessions, old login attempts and idempotency
  keys; SSE does not re-check the session after it is opened (closes on reconnect only);
  `/api/state` and movement planning load the full ledger (fine for stage 1 volumes);
  generate the Compose `postgres` tag from `server/pg-version.json` in E1.T8.

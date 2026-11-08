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
- [ ] E1.T1 Server scaffold: `package.json` (pinned deps), Fastify app with config from
      `.env` (`.env.example`), TZ, `/api/health`, migration runner, `embedded-postgres` dev/test
      harness, `npm run db:reset` with invented seed, `.pgdata/` ignored, `node --test` setup.
- [ ] E1.T2 Schema and domain: migration 001 with the 2.1-equivalent model (users, role
      permissions, sessions, login attempts, techs, shift list and shift changes, categories,
      tools, units, assignments, movements + transfers with append-only trigger, controls +
      items with unique original per tech/period and finalized-immutable trigger, alert
      resolutions, audit log, settings). Pure domain ported from 2.1 (pools from transfers,
      periods, effective control, alerts) with unit tests.
- [ ] E1.T3 Auth and users: argon2id, httpOnly session cookie with "Mantener la sesión",
      CSRF token, server-side progressive lockout (5 failures, 30 s doubling, max 15 min),
      admin creates/deactivates/resets users (forced change), roles admin/gerencia/supervisor/
      responsable/consulta with configurable permissions, permission check on every endpoint.
- [ ] E1.T4 API for every 2.1 operation: CRUD (techs, tools, units, categories, turnos),
      movements with server-side stock validation, controls (draft, finalize, correction),
      alert resolutions, audit, permissions; schema validation; `version` + `If-Match` -> 409;
      SSE `/api/events`; audit on every important action; idempotency keys for drafts.
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

## Next step
- E1.T1 Server scaffold (delegated writer).

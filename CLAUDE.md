# CLAUDE.md

> **Git policy — never auto-commit or auto-push.** Leave work in the working tree.
> Run `git commit`, `git push`, `gh pr create`, or `scripts/push_all.sh` **only when the
> user explicitly asks in that turn**. Finishing a task is not permission to commit it.
> No feature branches — stay on the current branch.

Context for AI assistants working on this codebase.

## Project Overview

`sudojo_api` (private, `BUSL-1.1`; version in `package.json`) is the backend REST API for Sudojo, a Sudoku learning platform. It runs **Hono on Bun** and sits between the Sudojo clients and PostgreSQL, the C# solver service, the OCR ML service, Firebase Auth, and RevenueCat.

**Responsibilities:** content CRUD (levels 1–12, techniques 1–60, strategies, learning, communities), puzzles (boards, dailies with a fallback, challenges, technique examples/practices), solver proxy with hint point tracking, play sessions and gamification (points, badges, user level), user accounts (subscription lookup, soft delete), OCR, and optional AES-256-GCM encryption of `solution` fields.

Full route reference: **[docs/API.md](docs/API.md)**.

## Commands

**This project uses Bun exclusively.** Do not use npm, yarn, or pnpm. Installing `@sudobility/*` scoped deps requires auth to **GitHub Packages** (`.npmrc` → `npm.pkg.github.com`); CI/Docker write a `GH_PACKAGES_TOKEN` to `~/.npmrc` before `bun install`.

```bash
bun install              # Install deps
bun run dev              # bun --watch src/index.ts, port $PORT (default 3000)
bun run start            # bun run src/index.ts
bun run build            # bun build → dist/ (gitignored), target bun
bun run build:compile    # standalone executable dist/server
bun run typecheck        # tsc --noEmit
bun run lint             # eslint src   (scripts/ and tests/ are ignored)
bun run format[:check]   # prettier write / check src
bun run test             # Unit tests, vitest. Never touches a DB; this is what CI runs.
bun run test:db          # DB tests (*.db.test.ts), vitest. MANUAL -- never run in CI.
                         # Requires TEST_DATABASE_URL at exactly localhost; refuses any other host.
bun run test:watch       # vitest watch (unit config)
bun run db:init          # Create/migrate tables (also runs automatically at server start)
bun run db:seed-badges   # Seed level_N / games_N badge definitions
```

Verified clean 2026-11 (Bun 1.4.2): `typecheck`, `lint`, `format:check`, `test`. Not run: `dev`/`start` (long-running), `test:db`/`db:*` (need a database), `build:compile`.

**Never run bare `bun test`.** That is Bun's own runner: it ignores `vitest.config.ts` and the setup files, so the localhost `TEST_DATABASE_URL` guard never runs, and Bun auto-loads `.env`, which holds a **remote** `DATABASE_URL`. The `*.db.test.ts` helpers delete table contents.

## Architecture

```
clients (sudojo_app, _rn, _extension, _bot via @sudobility/sudojo_client or raw fetch)
   │  HTTPS  /api/v1/*   Authorization: Bearer <Firebase ID token>
   ▼
src/index.ts  Hono app: logger → cors → GET / and /health → encryptSolutionsMiddleware(/api/v1/*)
   │            → routes. onError → 500 envelope, notFound → 404; exports { port, fetch, idleTimeout: 120 }
   ▼
src/routes/index.ts  mounts 15 routers (levels, techniques, strategies, learning, boards, dailies,
   │                  challenges, users, solver, examples, practices, play, gamification, ocr, communities)
   ├── middleware/auth.ts          adminMiddleware (token + SITEADMIN_EMAILS) on every admin write
   ├── middleware/firebaseAuth.ts  users/*, play/*, gamification/{stats,history}; rejects anonymous users
   ├── middleware/optionalAuth.ts  solver/solve only; optional token → firebaseUser, gates nothing
   ▼
db/ (Drizzle + postgres.js) ── PostgreSQL (DATABASE_URL)
services/solver-proxy.ts ── GET ${SOLVER_URL}/api/{solve,validate,generate}   (sudojo_solver, C#)
routes/ocr.ts ───────────── dispatch by `source`: camera → paddle; library → ML, then paddle
services/ocr-ml-proxy.ts ── POST ${OCR_ML_URL}/v1/ocr (sudojo_ocr_ml) → OCRExtractData
services/ocr-paddle.ts ──── @sudobility/sudojo_ocr crops the board → POST ${PADDLE_OCR_URL}/v1/ocr
services/firebase.ts     ── @sudobility/auth_service (firebase-admin), initialized at import time
middleware/subscription.ts ── @sudobility/subscription_service (RevenueCat), lazily, only if REVENUECAT_API_KEY set
```

Startup: `src/index.ts` calls `initDatabase()` then `initGamificationTables()`. On failure the process exits. Bun starts serving from the default export without waiting for schema init to finish.

## Repo Map

```
src/
├── index.ts         # Entry: middleware, health, error/404 handlers, DB init, SIGTERM/SIGINT shutdown
├── routes/          # 15 Hono routers + index.ts registry (see docs/API.md)
├── middleware/      # auth, firebaseAuth, optionalAuth, subscription, encryptSolutions
├── services/        # solver-proxy, ocr-ml-proxy, ocr-paddle, ocr-canvas, firebase
├── db/
│   ├── index.ts     # Lazy client, `db` proxy/getDb(), initDatabase() + initGamificationTables() raw SQL
│   ├── schema.ts    # Drizzle table defs (kept in sync with the raw SQL BY HAND)
│   ├── init.ts / seed-badges.ts   # db:init / db:seed-badges entry points
├── schemas/index.ts # All Zod request schemas
├── lib/             # env-helper, solution-crypto, localization (i18n keys), ocr-log,
│                    #   bitmask.ts (bitmask parse/SQL bind/response + types),
│                    #   levels.ts (technique→level 1-12: THE source of truth)
└── scripts/         # community seeders
scripts/             # One-off data scripts: `bun run scripts/<name>.ts`; they write to DATABASE_URL
                     #   (import-*, seed-levels-techniques, populate-*, backfill-board-difficulty,
                     #    verify-technique-levels, reset-*, repairs/, …)
tests/
├── unit/            # env-helper, schemas, bitmask, db-init, boards/bitmask/solver routes over
│                    #   fake-postgres.ts (stub postgres.js behind a real Drizzle instance)  (bun run test)
├── *.db.test.ts     # Route tests against a real DB via app.fetch (bun run test:db)
├── setup.ts         # Unit setup: scrubDatabaseUrl() from @sudobility/test-db-guard
├── setup.db.ts      # DB setup: loads .env.test, setupTestDatabase() guard, vi.mock firebase
└── db-helpers.ts    # setup/cleanup/close, test tokens, getAuthHeaders
docs/API.md          # Route reference        Dockerfile  # oven/bun:1 → :1-slim, EXPOSE 8010
.github/workflows/ci-cd.yml  # Calls johnqh/workflows unified-cicd.yml
```

## Environment Variables

`getEnv()` (`src/lib/env-helper.ts`) reads `process.env`, then a `.env.local`, then the default. Bun auto-loads `.env` for `bun run`. Templates: `.env.example`, `.env.test.example`; real `.env`/`.env.test` are gitignored live credentials — never print or copy them. Access env only via `getEnv`/`getRequiredEnv`, never `process.env` in `src/`.

| Variable | Req. | Notes |
|----------|------|-------|
| `DATABASE_URL` | yes | `db/index.ts`, scripts. Read lazily on first query |
| `FIREBASE_PROJECT_ID` / `_CLIENT_EMAIL` / `_PRIVATE_KEY` | yes | `services/firebase.ts`, read at **import** time. Importing any route without them throws |
| `SOLVER_URL` | yes | `solver-proxy.ts`, import time, no default. Scripts default to `http://localhost:8080` |
| `PORT` | no | Default `3000` (Dockerfile EXPOSEs 8010, so set `PORT=8010` in the container) |
| `SOLVER_TIMEOUT_MS` | no | Default `60000` |
| `SITEADMIN_EMAILS` | no | Comma-separated admin emails. `ADMIN_EMAILS` is a legacy fallback only if unset |
| `REVENUECAT_API_KEY` | no | Unset: `/users/:id/subscriptions` → 500, and `DELETE /users/:id` skips the active-sub check |
| `ADMIN_API_KEY` | no | On `solver/solve`, matching `X-API-Key`/`?api_key=` skips token verify, caller treated as anonymous. Unlocks nothing (hints are unrestricted); kept for behaviour parity |
| `SOLUTION_ENCRYPTION_KEY` | no | 64 hex chars. Unset: solutions sent in plaintext |
| `OCR_ML_URL`, `OCR_ML_TIMEOUT_MS` | no | Unset URL: paddle only. Timeout default `20000` |
| `PADDLE_OCR_URL`, `PADDLE_OCR_TIMEOUT_MS` | no | Unset URL: camera scans 503, library scans use ML alone. Default `30000` |
| `APPLE_CLIENT_ID`/`_TEAM_ID`/`_KEY_ID`/`_PRIVATE_KEY` | no | Apple token revocation on account delete; all four needed |
| `TEST_DATABASE_URL` | tests | Host must be exactly `localhost` (not `127.0.0.1`) |

`SOLVER_API_KEY` appears in the templates but no code reads it.

## Auth & Access Model

| Layer | Where | Rule |
|-------|-------|------|
| Public | All content GETs, `solver/validate`, `solver/generate`, `ocr/extract`, `gamification/badges` | No auth |
| Admin | Every POST/PUT/DELETE on content, plus `boards/update-stats`, `practices/regenerate-hints` | `adminMiddleware`: valid token + admin email |
| User | `users/*` (own uid only), `play/*`, `gamification/stats\|history` | `firebaseAuthMiddleware`, anonymous → 403 |
| Optional | `solver/solve` | `optionalAuthMiddleware`: no token OK, valid token sets `firebaseUser`, bad token → 401 `AUTH_TOKEN_INVALID` |

**Hints are deliberately unrestricted.** Every caller (anonymous or free) gets every hint level from `solver/solve` — the owner's decision. The route check was removed in 4e8de9b (Mar 2026); the tier code (`hintAccess.ts`, `maxHintLevel`, `HINT_LEVEL_LIMITS` use) and the daily-limit gate (`accessControl.ts`, `services/access.ts`) were deleted. **Don't reintroduce them as a "fix".** `tests/unit/solver-unrestricted.test.ts` pins this. Clients gate hints themselves via each level's `entitlement` (`blue_belt,red_belt` for 8–10, `red_belt` for 11–12) and `offer_id`. `@sudobility/sudojo_types` still exports `HINT_LEVEL_LIMITS`/`HintAccessDenied*` and clients still handle a 402 `HINT_ACCESS_DENIED` / "Daily limit reached"; the API never sends either.

## Difficulty Levels

**`src/lib/levels.ts` is the single source of truth for the 1-12 scale.** The API does **not** read `level` from the solver — `TECHNIQUE_LEVELS` maps each technique id 1–60 to a level and everything derives from it: board level = `levelForBitmask(mask)` (max over bitmask, in `src/lib/bitmask.ts`); hint level = `levelForTechnique(hints.technique)` (in `solver.ts`); `boards.level` via `backfill-board-difficulty.ts`; `techniques.level` via `verify-technique-levels.ts`. The solver's `level` is overwritten so a solver rebalance or old deployment can't change what clients see; its `difficulty_score` is what the bands are built on.

**Invariant:** `level` must be a non-decreasing banding of `difficulty_score` (the solver tries techniques easiest-first by score), and no technique may sit below one it builds on. `src/lib/levels.test.ts` enforces this plus all 12 levels non-empty.

**To change a technique's level:** edit `TECHNIQUE_LEVELS` → `bun run test:unit` (invariants) → `bun run scripts/verify-technique-levels.ts --fix` (sync `techniques.level`) → `bun run scripts/backfill-board-difficulty.ts` (~2h against prod solver). A `difficulty_score` change, by contrast, is a `sudojo_solver` change (`GetDifficultyScore`) — deploy it first, then backfill.

## Database

- Schema lives in **two places**: raw `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS` SQL in `src/db/index.ts` (what runs), and Drizzle defs in `src/db/schema.ts` (types/queries). `drizzle-kit` is installed but has no config/migrations. Migrations are forward-only. When adding a column, put the `ALTER` **after** the table's `CREATE` (743dbc3 fixed a fresh-DB bootstrap break).
- `initDatabase()` seeds idempotently: strategy rows, technique→strategy mappings, level `entitlement`/`offer_id`.
- Core tables: `levels`, `strategies` (17), `techniques`, `learning`, `boards`, `dailies`, `challenges`, `access_logs` (leftover from the deleted gate; created, never written), `technique_examples`, `technique_practices`, `communities`. Gamification: `user_stats` (has `status` for soft delete), `badge_definitions`, `user_badges`, `game_sessions`, `point_transactions`.
- **Technique bitmasks** use `1n << BigInt(techniqueId)` (ids 1–60), so values exceed 2^53. `boards.techniques`, `dailies.techniques`, `technique_examples.techniques_bitfield`, `game_sessions.techniques` are `bigint({ mode: "bigint" })` (JS `bigint` in/out). `user_stats.total_points` is not a bitmask → `mode: "number"`. SQL counting uses `1::bigint << t`.

## Gamification

- `POST /play/start` stores one `game_sessions` row per user (replacing older).
- A hint from `GET /solver/solve` whose `original` matches the active session awards `2 × hints.level` points and sets `hintUsed`.
- `POST /play/finish` computes `2^level × 10 (no hints) × 2 (not interrupted)`; interrupted = client `elapsedTime` >1s below server time. Perfect play raises `userLevel` and awards `level_<n>`. Milestone `games_<5…10000>` badges exist. Every change writes a `point_transactions` row.

## Conventions

- Validate every body/param with Zod from `src/schemas/index.ts` via `zValidator`; query strings are parsed by hand in handlers.
- Respond with `successResponse()` / `errorResponse()`. Each route `export default`s its `Hono` router; register it in `src/routes/index.ts`. Attach i18n keys via `src/lib/localization.ts` helpers, not literal strings.
- **Bitmasks are `bigint` everywhere inside the API** and go through `src/lib/bitmask.ts`: parse input with `parseBitmask()` (the `bitmask` zod helper), bind SQL with `bitmaskParam(value)` (`$n::bigint` with a decimal-string param, never a JS number), build bits with `techniqueBit(id)`. Pass every row with a bitmask column through `toBitmaskFields()` before `c.json` — `JSON.stringify` throws on `bigint`. It emits `<field>` as a (lossy) number and `<field>_bitmask` as the exact string. `tests/unit/bitmask-routes.test.ts` fails if a `bigint` reaches a response.
- Prefer `techniqueBit()` over `@sudobility/sudojo_types`' `techniqueToBit`/`addTechnique`/`hasTechnique`, which take/return JS numbers and are lossy for ids ≥ 54.
- Prettier: double quotes, semicolons, width 80, 2 spaces, trailing commas `es5`, `arrowParens: avoid`, LF. ESLint: `no-unused-vars` ignores `^_`, `no-explicit-any` off.
- Commits are `type: summary` / `type(scope): summary`. Releases bump `package.json` `version`.

## Testing

- **One runner, two configs.** `bun run test` (`vitest.config.ts`) excludes `**/*.db.test.ts` so CI can't reach a DB; `bun run test:db` (`vitest.db.config.ts`) collects only those, run by hand (`fileParallelism: false`).
- **`TEST_DATABASE_URL`, not `DATABASE_URL`.** `tests/setup.db.ts` validates it is exactly `localhost` before assigning `DATABASE_URL`, loads `.env.test` **only** (never `.env`), and never overrides an already-set env var. `.env.test` is gitignored (live creds); `.env.test.example` is the template.
- Only Firebase is mocked via `vi.mock` in `tests/setup.db.ts` (`test-firebase-token` → admin `test@example.com`); hoisted, so factories inline string literals (a const errors "cannot access before initialization"). Keep in sync with `tests/db-helpers.ts`. `solver*.db.test.ts` call a **live solver** at `.env.test`'s `SOLVER_URL`.
- Both configs inline `@sudobility/auth_service` + `subscription_service` (`server.deps.inline`) — their extensionless ESM imports break Node's resolver.

## Deploy

CI (`.github/workflows/ci-cd.yml` → `johnqh/workflows/.../unified-cicd.yml@main`) runs on pushes/PRs to `main`/`develop`: `bun install`, `typecheck`, `lint`, `test`, `build`. On `main` only it builds the Dockerfile and pushes `<DOCKERHUB_USERNAME>/sudojo_api` tagged with the `package.json` version. `develop` runs tests only; **no npm publish** (`skip-npm-publish: true`, `publish-target: github`). The Dockerfile authenticates to GitHub Packages with a `GH_PACKAGES_TOKEN` build arg; the runtime image runs `bun run src/index.ts` from TS source with prod deps only.

## Gotchas

- **Dynamic filters:** each `.where()` on a Drizzle `$dynamic()` builder **replaces** the previous. Collect conditions in an array → `.where(and(...conditions))` once. Wrap raw `sql` with `OR` in parens (`and()` does not). (Fixed in `GET /boards`; covered by `tests/unit/boards-route.test.ts`.)
- **Bitmask columns are `mode: "bigint"`** → a route returning such a row without `toBitmaskFields()` throws `TypeError: Do not know how to serialize a BigInt`. These columns are now `BIGINT`; `initDatabase()` widens any leftover `INTEGER` via `widenColumnToBigint()`. `tests/unit/db-init.test.ts` fails if a Drizzle `bigint` column is created as another type.
- `/dailies/today` uses the UTC date; a missing daily returns an unpersisted scrambled board `uuid: "fallback-<date>"`.
- `GET` responses under `/api/v1` are re-serialized by the encryption middleware when a key is set — clients must decrypt `enc:` values.
- Health `version` is hard-coded `"1.0.0"`; `/health` does not check the DB.
- Scripts in `scripts/` and `src/scripts/` write to whatever `DATABASE_URL` resolves to, and Bun loads `.env` (**remote**). `update-technique-dependencies.ts` says to run with `bunx tsx`.
- `access_logs` remains but is never written; dropping it needs a migration decision.
- `.claude/settings.local.json` is committed even though `.gitignore` lists it.

## Common Tasks

**Add an endpoint:** handler in `src/routes/<module>.ts` (or new module registered in `src/routes/index.ts`) → Zod schema in `src/schemas/index.ts` + cases in `tests/unit/schemas.test.ts` → apply `adminMiddleware`/`firebaseAuthMiddleware` → add shared types to `@sudobility/sudojo_types` and the path to `sudojo_client`'s endpoint map → update `docs/API.md`.

**Add a table/column:** Drizzle def in `src/db/schema.ts` (bitmask col = `bigint({ mode: "bigint" })`, name in `BITMASK_FIELDS`, responses through `toBitmaskFields()`) → raw SQL in `src/db/index.ts` after the table's CREATE → `bun run db:init`.

## Cross-Repo Contracts

See the detailed table in **[docs/API.md](docs/API.md)**. Key points:
- **`sudojo_solver`** (C#): `GET ${SOLVER_URL}/api/{solve,validate,generate}`, envelope `{ success, error:{code,message}, data }` where `code` is an integer 0–3 (`SolverErrorCode`). `/validate` & `/generate` `data.board` carries `techniques` (lossy JSON number) and `techniques_bitmask` (exact decimal string) — read with `solverBitmask()` (prefers the string). `hints.technique === 0` = auto-pencilmark hint. Technique ids 1–60 mirror `SudokuEngine/SudokuDefines.h`. Its `level` is ignored; `difficulty_score` is passed through.
- **`@sudobility/sudojo_types`**: envelope helpers, entity/response types, `EMPTY_BOARD`, `scrambleBoard`. New shared shapes go here first. The `_bitmask` response fields aren't published yet, so `src/lib/bitmask.ts` extends `Board`/`Daily`/`TechniqueExample`/`ValidateBoardData` locally (`TODO(sudojo_types)`).
- **Bitmask wire contract:** every bitmask field is sent twice — `techniques` (lossy number, kept for old store builds) + `techniques_bitmask` (exact decimal string); likewise `techniques_bitfield(+_bitmask)`. Clients read the string with `BigInt(...)`. Inputs accept a number or a decimal string.
- **OCR:** `sudojo_ocr_ml` `POST ${OCR_ML_URL}/v1/ocr` `{ image, min_clues }` → `OCRExtractData` (422 = too few clues); `@sudobility/sudojo_ocr` does board detect+crop then paddle (`POST ${PADDLE_OCR_URL}/v1/ocr`), no Tesseract.
- **i18n:** responses carry `localization` string keys (`levels.<n>.*`, `techniques.<path>.*`, `badges.<key>.*`, `learning.<path>.<i>`); clients resolve against locale files. `src/scripts/seed-communities.ts` reads `sudojo_app/docs/communities.md` via a sibling-relative path.
- Dep versions live in `package.json` (`@sudobility/*` from GitHub Packages) — don't duplicate pins here.

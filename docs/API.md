# sudojo_api Route Reference

Every route the server registers, derived from `src/index.ts` and `src/routes/*.ts`.
All API routes live under `/api/v1`; the route modules are mounted in `src/routes/index.ts`.

## Conventions

| Topic | Behavior |
|-------|----------|
| Envelope | `successResponse(data)` → `{ success: true, data, timestamp }`; `errorResponse(msg)` → `{ success: false, error, timestamp }` (both from `@sudobility/sudojo_types`) |
| Validation errors | `@hono/zod-validator` default hook: HTTP 400 with `{ success: false, error: <ZodError object> }`, **not** the envelope above |
| Auth header | `Authorization: Bearer <Firebase ID token>`; verified through `@sudobility/auth_service` (tokens cached 5 min) |
| `?testMode=true` | Passed to RevenueCat `getSubscriptionInfo` so sandbox purchases count (users/subscriptions, users DELETE) |
| Solution encryption | If `SOLUTION_ENCRYPTION_KEY` is set, every **GET** JSON response under `/api/v1/*` has each `solution` string field replaced with `enc:` + base64(nonce ‖ ciphertext ‖ tag), AES-256-GCM (`src/middleware/encryptSolutions.ts`) |
| Unknown route | 404 `errorResponse("Not found")`; unhandled throw → 500 `errorResponse("Internal server error")` |
| Technique bitmasks | See [Technique bitmasks](#technique-bitmasks): every bitmask field is sent twice, as a number and as an exact `<field>_bitmask` string |

### Auth levels

| Label | Middleware | Rule |
|-------|-----------|------|
| Public | none | No header needed |
| Admin | `adminMiddleware` (`src/middleware/auth.ts`) | Valid token and email in `SITEADMIN_EMAILS` (falls back to `ADMIN_EMAILS`); 401 bad/missing token, 403 non-admin |
| User | `firebaseAuthMiddleware` (`src/middleware/firebaseAuth.ts`) | Valid token, not an anonymous Firebase user (403); sets `userId`, `userEmail`, `siteAdmin` |
| Optional | `optionalAuthMiddleware` (`src/middleware/optionalAuth.ts`) | No header is fine. A valid `Bearer` token identifies the user (for hint points). A bad token returns 401 `{ success: false, error: "Invalid or expired token", code: "AUTH_TOKEN_INVALID" }` so clients refresh and retry. A matching `ADMIN_API_KEY` (`X-API-Key` or `?api_key=`) skips token verification |

## Health

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/` | Public | `{ name: "Sudojo API", version: "1.0.0", status: "healthy" }` (version is hard-coded, not from package.json) |
| GET | `/health` | Public | Same payload; does not check the database |

## Content (public read, admin write)

| Method | Path | Auth | Params / body |
|--------|------|------|---------------|
| GET | `/levels` | Public | Adds `localization` keys `levels.<n>.title/text` |
| GET | `/levels/:level` | Public | `level` 1–12 |
| POST | `/levels` | Admin | `levelCreateSchema` |
| PUT | `/levels/:level` | Admin | `levelUpdateSchema` |
| DELETE | `/levels/:level` | Admin | Cascades to techniques (FK `ON DELETE CASCADE`) |
| GET | `/techniques` | Public | `?level=`; ordered by title; adds `localization` from `path` |
| GET | `/techniques/path/:path` | Public | Slug, e.g. `naked-single` |
| GET | `/techniques/:technique` | Public | 1–60 |
| POST / PUT / DELETE | `/techniques[/:technique]` | Admin | `techniqueCreateSchema` / `techniqueUpdateSchema` |
| GET | `/strategies` | Public | Sorted by difficulty (17 seeded groups) |
| GET | `/strategies/stub/:stub` | Public | e.g. `naked-subsets` |
| GET | `/strategies/:strategy` | Public | Integer id |
| POST / PUT / DELETE | `/strategies[/:strategy]` | Admin | `strategyCreateSchema` / `strategyUpdateSchema` |
| GET | `/learning` | Public | `?technique=`, `?language_code=` |
| GET | `/learning/:uuid` | Public | |
| POST / PUT / DELETE | `/learning[/:uuid]` | Admin | `learningCreateSchema` / `learningUpdateSchema` |
| GET | `/communities` | Public | `?language=` |
| GET | `/communities/:uuid` | Public | |
| POST / PUT / DELETE | `/communities[/:uuid]` | Admin | `communityCreateSchema` / `communityUpdateSchema` |

## Technique bitmasks

A technique bitmask sets bit N for technique id N (currently 1–60; storage supports ids through 127): `1n << BigInt(id)`. Once any id ≥ 54 is set, the value exceeds 2^53, and `JSON.parse` or a JS `number` silently rounds away the low bits. The API keeps these values as `bigint` internally and stores them in PostgreSQL `bit(128)` columns.

**Responses.** Each bitmask field keeps its numeric form, which old app builds read and which is as lossy as it always was. Each one also gets an exact base-10 string companion:

| Numeric field (lossy) | Exact string field | Returned by |
|-----------------------|--------------------|-------------|
| `techniques` | `techniques_bitmask` | every `/boards` item (list, random, `:uuid`, POST, PUT, DELETE); every `/dailies` item, including the `fallback-<date>` daily; `data.board` of `/solver/validate` and `/solver/generate` |
| `techniques_bitfield` | `techniques_bitfield_bitmask` | every `/examples` item (list, random, `:uuid`, POST, PUT, DELETE) |

A NULL `techniques` column is `null` in both fields. **JS clients should read `<field>_bitmask` and parse it with `BigInt(...)`**, and test bits with `(mask >> BigInt(id)) & 1n`. The legacy numeric field carries only the low 64 bits and may lose precision. For the two solver routes, the API takes the solver's own `techniques_bitmask` when present and otherwise falls back to `BigInt(techniques)`: for an older solver deployment that can lack low bits, but it never invents any.

**Requests.** Bitmask inputs accept a JSON number up to 2^53 − 1 or a decimal string of at most 39 digits, parsed with `BigInt`. Anything above 2^53 must be a string: a JSON number that large has already lost its low bits, so it is rejected with "Bitmasks above 2^53 must be sent as a decimal string". The one exception is `gameStartSchema` (`POST /play/start`), which still accepts such numbers so old app builds can start games. This covers `techniques` in `boardCreateSchema` / `boardUpdateSchema` / `dailyCreateSchema` / `dailyUpdateSchema` / `gameStartSchema`, `techniques_bitfield` in the example schemas (which must be at least 1), and the `/boards` query params `techniques` and `technique_bit`. Negative, fractional, exponent, hex, empty-string, over-long (> 39 digits, rejected before parsing) or out-of-range (> 2^128 − 1) values are rejected. Bodies fail with the usual zod-validator 400. The `/boards` query params fail with 400 `errorResponse("Invalid techniques: …")`. A body `null` still means 0.

**SQL.** Bitmask filters bind their value as a 128-character binary string cast to `bit(128)` (`$n::bit(128)`, via `bitmaskParam()` in `src/lib/bitmask.ts`), never as a JS number.

## Puzzles

| Method | Path | Auth | Params / body |
|--------|------|------|---------------|
| GET | `/boards` | Public | `?level=&technique_bit=&techniques=&limit=&offset=`. Filters are ANDed. `technique_bit` matches any of its bits (0 is ignored); `techniques` is an exact match, and `techniques=0` also matches NULL. Both are decimal bitmasks (see above); an invalid one → 400 |
| GET | `/boards/counts` | Public | `{ total, withoutTechniques }` |
| GET | `/boards/counts/by-technique` | Public | Map of technique id (1–60) → count; runs 60 queries |
| GET | `/boards/random` | Public | `?level=&symmetrical=true` |
| GET | `/boards/:uuid` | Public | |
| POST | `/boards/update-stats` | Admin | Recomputes `levels.percentage` and `techniques.percentage` ratios (0–1) |
| POST / PUT / DELETE | `/boards[/:uuid]` | Admin | `boardCreateSchema` / `boardUpdateSchema` |
| GET | `/dailies` | Public | All dailies, newest date first |
| GET | `/dailies/today` | Public | UTC date; if no row exists, returns a scrambled random level 3–5 board with `uuid: "fallback-<date>"` (not persisted) |
| GET | `/dailies/date/:date` | Public | `YYYY-MM-DD`; same fallback |
| GET | `/dailies/:uuid` | Public | |
| POST / PUT / DELETE | `/dailies[/:uuid]` | Admin | `dailyCreateSchema` / `dailyUpdateSchema` |
| GET | `/challenges` | Public | `?level=&difficulty=` (difficulty 1–10) |
| GET | `/challenges/random` | Public | `?level=&difficulty=` |
| GET | `/challenges/:uuid` | Public | |
| POST / PUT / DELETE | `/challenges[/:uuid]` | Admin | `challengeCreateSchema` / `challengeUpdateSchema` |
| GET | `/examples` | Public | `?technique=` (primary technique) or `?has_technique=` (technique id whose bit must be set in `techniques_bitfield`); 400 on unknown id |
| GET | `/examples/counts` | Public | Map of primary technique → count |
| GET | `/examples/random` | Public | `?technique=` |
| GET | `/examples/:uuid` | Public | |
| POST / PUT / DELETE | `/examples[/:uuid]` | Admin | `techniqueExampleCreateSchema` / `techniqueExampleUpdateSchema` |
| GET | `/practices/counts` | Public | Every technique with its practice count |
| GET | `/practices/technique/:technique/random` | Public | 404 when that technique has none |
| GET | `/practices/:uuid` | Public | |
| POST | `/practices` | Admin | `techniquePracticeCreateSchema` |
| DELETE | `/practices?confirm=true` | Admin | Deletes **all** practices; 400 without `confirm=true` |
| DELETE | `/practices/:uuid` | Admin | |
| POST | `/practices/regenerate-hints` | Admin | Re-calls the solver for every example and practice row and rewrites `hint_data`; long-running |

There is no `GET /practices` list route, even though `@sudobility/sudojo_client` defines a `PRACTICES` endpoint constant.

## Solver proxy

Forwards to `${SOLVER_URL}/api/{solve,validate,generate}` on the C# service (`sudojo_solver/SudokuApi`) via `src/services/solver-proxy.ts`, with a `SOLVER_TIMEOUT_MS` abort timeout (default 60000). The solver replies `{ success, error: { code, message } | null, data }`. `code` is the integer value of its `ErrorCode` enum: 0 unknown, 1 auto-pencilmarks required, 2 cannot solve, 3 multiple solutions.

| Method | Path | Auth | Params | Behavior |
|--------|------|------|--------|----------|
| GET | `/solver/solve` | Optional | `original` (81), `user` (default 81 zeros), `autopencilmarks` (default `"false"`), `pencilmarks` (default `EMPTY_PENCILMARKS`), `techniques` (comma list) | With `techniques`, retries unfiltered when the filtered call fails or returns `hints.level === 0`. Rewrites each step's `localization` to `{ text, title }` (title key `techniques.<path>.title`). If the caller has an active `/play` session on the same `original`, awards `2 × hints.level` points and adds `data.points` |
| GET | `/solver/validate` | Public | `original` (81, else 400), `brutalForce` | Whole query string forwarded as-is. `data.board` gains `techniques_bitmask` (see [Technique bitmasks](#technique-bitmasks)) |
| GET | `/solver/generate` | Public | `symmetrical` | Whole query string forwarded as-is; solver failure → 500. `data.board` gains `techniques_bitmask` |

Solver failure (`success: false`) → 400 with `"<code>: <message>"` (e.g. `"2: Cannot solve this Sudoku puzzle"`); network error/timeout → 503 `"Solver service unavailable"`.

**Hints are unrestricted, by design.** The server neither computes nor enforces hint tiers. Every caller, anonymous or not, gets every hint level, and `/solver/solve` never returns 402. Clients gate hints using the level's `entitlement` field. Client code still handles a 402 `HINT_ACCESS_DENIED` from when the server enforced tiers (removed in 4e8de9b), but the server never sends it.

## Users (User auth, own account only)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/users/:userId` | 403 if token uid ≠ `:userId`, account `status = deleted`, or user not found |
| GET | `/users/:userId/subscriptions` | RevenueCat entitlements → `SubscriptionResult`; 500 if `REVENUECAT_API_KEY` unset |
| DELETE | `/users/:userId` | 409 if an active subscription exists; 410 if already deleted. Soft-deletes (`user_stats.status = 'deleted'`), then deletes the Firebase user and revokes OAuth tokens. Optional JSON body `{ googleAccessToken?, appleAuthorizationCode? }`; Apple revocation needs `APPLE_*` env |

## Play and gamification

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/play/start` | User | `gameStartSchema` (`board`, `solution`, `level` 1–12, `techniques` (number or decimal-string bitmask), `difficultyScore`, `puzzleType: "daily" \| "level"`, `puzzleId?`). Replaces any existing session (one row per user) |
| POST | `/play/finish` | User | `{ elapsedTime }` seconds. Points = `2^level × (10 if no hint) × (2 if not interrupted)`; interrupted = client time < server time − 1s. Perfect play (no hint, no interruption) can raise `userLevel` and earn `level_<n>` badge; `games_<n>` milestone badges at 5…10000 games. Deletes the session |
| GET | `/gamification/badges` | Public | Badge definitions with `badges.<key>.title/description` localization keys |
| GET | `/gamification/stats` | User | Totals plus earned badges |
| GET | `/gamification/history` | User | `?limit=` (default 20, max 100), `?offset=` |
| POST | `/gamification/badges` | Admin | `badgeDefinitionCreateSchema` |
| PUT / DELETE | `/gamification/badges/:badgeKey` | Admin | |

Badge definitions only exist after `bun run db:seed-badges`; awards are skipped silently when a definition is missing.

## OCR

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/ocr/extract` | Public | Body `{ image }` (base64 or data URL). If `OCR_ML_URL` is set, POSTs `{ image, min_clues: 17 }` to `${OCR_ML_URL}/v1/ocr` (`sudojo_ocr_ml`); an ML 422 → 400 "not enough digits". Any other ML failure falls back to Tesseract through `@sudobility/sudojo_ocr`. Fewer than 17 clues → 400 |

## Known gotchas

- The numeric `techniques` / `techniques_bitfield` response fields are still rounded above 2^53, which keeps old clients working. Only the `_bitmask` strings are exact.
- The `access_logs` table is still created at startup but nothing writes it. The daily-limit code that used it was never wired to a route and has been deleted.

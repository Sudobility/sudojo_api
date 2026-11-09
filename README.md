# sudojo_api

Backend API server for Sudojo, a Sudoku learning platform. Built with Hono on Bun.

## Setup

Requires [Bun](https://bun.sh) (1.4+). The `@sudobility/*` dependencies come from
**GitHub Packages**, so before installing you need a GitHub token with `read:packages`
in `~/.npmrc` (the repo `.npmrc` points the `@sudobility` scope at `npm.pkg.github.com`):

```
//npm.pkg.github.com/:_authToken=<YOUR_TOKEN>
```

```bash
bun install
# Copy .env.example to .env; DATABASE_URL, FIREBASE_* and SOLVER_URL are required
bun run db:init      # Initialize database tables (also runs on server start)
bun run dev          # Start dev server (port 3000, or $PORT)
```

## Routes

All routes are under `/api/v1`. See [docs/API.md](docs/API.md) for the full reference.

| Prefix | Purpose |
|--------|---------|
| `/levels`, `/techniques`, `/strategies`, `/learning`, `/communities` | Learning content (public read, admin write) |
| `/boards`, `/dailies`, `/challenges`, `/examples`, `/practices` | Puzzles (public read, admin write) |
| `/solver` | Proxy to the sudojo_solver service (`/solve`, `/validate`, `/generate`) |
| `/play`, `/gamification` | Game sessions, points, badges |
| `/users` | Account info, subscriptions, deletion |
| `/ocr` | Image-to-puzzle extraction |

Writes require a Firebase ID token for an email in `SITEADMIN_EMAILS`. The `/users`, `/play`, and `/gamification/{stats,history}` routes require a signed-in (non-anonymous) Firebase user.

## Development

```bash
bun run dev          # Dev server with hot reload
bun run test         # Unit tests (vitest). Do not use bare `bun test`
bun run test:db      # DB tests; needs TEST_DATABASE_URL on localhost
bun run typecheck    # TypeScript check
bun run lint         # ESLint
bun run format       # Prettier
```

## Related Packages

- `@sudobility/sudojo_types` -- Shared type definitions
- `@sudobility/sudojo_client` -- Typed client for this API
- `sudojo_app` / `sudojo_app_rn` / `sudojo_extension` / `sudojo_bot` -- Consumers
- `sudojo_solver` -- Sudoku solving engine API (`SOLVER_URL`)
- `sudojo_ocr_ml` -- Optional OCR model service (`OCR_ML_URL`)

## License

BUSL-1.1

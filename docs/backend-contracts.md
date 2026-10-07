# Backend contracts (pilot inventory)

Source of truth: `src/server.ts`, global request hooks and route registrations; security classifications: `src/core/antibot/routes.ts`. This is a compact inventory, not an OpenAPI specification.

## Access and response conventions

- Startup requires OIDC configuration. There is no supported public/development mode; comments describing the old open local mode are stale. With OIDC active, unknown routes are protected too: APIs receive 401 JSON and browser navigations redirect to login. Do not infer public access from the route's generic handler.
- Public catalog exceptions are explicitly enumerated by the server gate. `/lote/:slug` requires a session; it is not public, including its legacy anonymous SSR branch. `/api/brands` requires a session and runs through `withReadResources`.
- API unauthenticated responses use 401 JSON (`{ error: "unauthorized" }` for a deleted identity, otherwise `{ erro: "não autenticado" }`); browser navigation redirects (302) to login. Preserve the existing distinctions.
- Invalid/bounded requests use route-specific 4xx payloads; the server error handler masks unexpected 5xx errors as `{ erro: "erro interno" }`. Authenticated API not-found responses use `{ erro: "não encontrado", rota }`; browser HTML handling differs. Preserve established English error fields/identifiers, status codes, and POST 201 responses where emitted by the route.
- Search and private data routes use anti-bot route policies and no-store handling as registered; do not cache personalized responses. Images have bounded request inputs and resource budgets. WebSocket upgrades have separate IP, session, and resource admission.

## Route groups

| Routes | Methods / policy | Notes |
| --- | --- | --- |
| `/`, `/robots.txt`, `/sitemap.xml`, catalog assets, `/api/vitrine` | GET; explicit public catalog routes | Public exceptions are gate-listed, not a default. |
| `/api/search`, `/api/search/mapa`, `/api/home`, `/api/home/leiloeiro`, `/api/malha/:tipo`, `/api/explain`, `/api/lot/:id`, `/api/brands`, `/api/me` | GET/HEAD as registered; `search`, `mapa`, or `detail` policy | Session required except explicitly gate-listed catalog routes. Brands envelope is `{ known, present }`; SQL and registration live in `brands.legacy.ts`. |
| `/api/alerts`, `/api/alerts/hits`, `/api/favorites`, `/api/push/key` | GET/HEAD; search policy | Owner-scoped data. |
| `/api/alerts` | POST, PATCH `/:id`, DELETE `/:id` | User alert CRUD. |
| `/api/alerts/hits/seen` | POST | Marks alert hits seen; distinct from GET hits. |
| `/api/favorites` | POST; DELETE `/:lotId` | Favorite mutation. |
| `/api/push/subscribe` | POST | Subscription input is bounded/validated. |
| `/api/espera`, `/api/cadastro` | POST | Explicit gate exceptions; preserve route-specific created status. |
| `/api/stats`, `/api/sources`, `/api/collect` | GET, GET, POST | Admin-only operational endpoints. |
| `/api/security/metrics` | GET/HEAD; search policy | Additional admin authorization. |
| `/api/img`, `/ws` | GET/HEAD; image policy, WS IP policy | Image and socket paths have dedicated budgets/admission. |
| `/api/login`, `/auth/login`, `/auth/callback`, `/auth/logout` | POST/GET as registered | OIDC/session lifecycle exceptions. |

## Safe test lane

`npm run test:isolated` runs the explicit safe list in `scripts/run-safe-tests.mjs` with Node's test runner and `tsx`; no `.env` loading, server listener, collection, network request, or Redis/DB service is part of the lane. Tests inject fakes or use in-memory Fastify where needed. `npm run test:coverage` runs the same list and adds Node 24 native test coverage restricted to `src/**/*.ts`; its denominator is the source files loaded by that run, not all repository source.

Existing integration/opt-in lanes are intentionally separate and not run by the safe runner: `npm run test:antibot:integration`, `npm run test:antibot:challenge:integration`, `npm run test:antibot:redis`, and `npm run test:antibot:ws:redis`. Their environment/service preconditions must be explicit before use. No real `.env`, database or Redis is a test prerequisite in this pilot.

The contract test characterizes route registration, SQL, response envelope, Fastify GET/HEAD behavior and resource lease cleanup. It does not exercise the production host's OIDC/IP/auth/global security hooks; that requires a later integration lane against the real host configuration.

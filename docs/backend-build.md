# Backend ESM build

`npm run build:backend` emits the TypeScript backend to `dist/src` with NodeNext
ESM resolution and copies `src/web` to `dist/src/web`. The build is rooted at
the repository location, not the caller's current directory. It does not copy
`app-busca`, certificates, secrets, or dependencies.

The compiled entrypoint is `dist/src/server.js`; after building, run it with
`npm run start:compiled` (which loads the local `.env`). This command starts
the application and is intentionally not run by build or CI. The root
`dev`/`start` and frontend build remain unchanged.

`npm run test:compiled` runs the host contract suite with
`HOST_VARIANT=compiled`. CI requires this suite after building the backend.

The NodeNext build uses ioredis's documented package entry (`main` and
`types` both target `built/index`): its declaration and CJS entry both export
the named `Redis` class, so production imports use `import { Redis } from
'ioredis'` rather than a default import that NodeNext resolves as a namespace.
The resolved ioredis package was `5.11.1`; `built/index.d.ts` and
`built/index.js` both confirm the named export.

## Bootstrap lifecycle

The production entrypoint owns startup and shutdown for its Fastify host and
optional local TLS terminator. `SIGINT`/`SIGTERM` and startup failures share
one idempotent cleanup: TLS stops accepting first, tracked TLS sockets are
destroyed, and Fastify close starts before awaiting TLS completion. Both owners
are attempted even if one fails; failures are aggregated and reported with a
nonzero exit status. Host-factory failures retain their own partial-resource
cleanup responsibility.

`scripts/teste-bootstrap-lifecycle.mjs` tests this boundary with fake close
handles and sockets; it does not start the server, open listeners, read
certificates, or connect to services. `npm run test:compiled` runs it alongside
the host contract suite against `dist`.

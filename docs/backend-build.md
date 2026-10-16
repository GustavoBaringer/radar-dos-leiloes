# Backend ESM build

`npm run build:backend` emits the TypeScript backend to `dist/src` with NodeNext
ESM resolution and copies `src/web` to `dist/src/web`. The build is rooted at
the repository location, not the caller's current directory. It does not copy
`app-busca`, certificates, secrets, or dependencies.

The compiled Nest entrypoint is `dist/src/main.js`. `npm start` builds the
backend and then runs `npm run start:compiled`; the latter reuses the current
build. Local `dev` aliases `npm start` and does not watch files. Use these local
commands only after confirming `.env` targets a disposable fixture; the
preload `scripts/local-runtime.mjs` forces loopback binding and Nest bootstrap.
`dev:legacy` preserves the old TSX watch command; `start:legacy` and
`start:compiled:legacy` preserve the old entrypoints with the local-only preload.
Docker/production remain unchanged and do not use this preload; the production
entrypoint remains `dist/src/server.js`. Source Nest via TSX exited 1 without
stdout/stderr in local diagnostics; cause is undetermined and this path is not
the supported local cutover.

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

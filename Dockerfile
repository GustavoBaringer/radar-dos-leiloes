FROM node:24-bookworm-slim AS backend-build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=corporate_ca,target=/run/secrets/corporate-ca.pem,required=false \
    if [ -f /run/secrets/corporate-ca.pem ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/corporate-ca.pem; fi; \
    npm ci
COPY tsconfig.json tsconfig.backend.json ./
COPY scripts/build-backend.mjs scripts/migrate.ts ./scripts/
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY src ./src
RUN --mount=type=secret,id=corporate_ca,target=/run/secrets/corporate-ca.pem,required=false \
    if [ -f /run/secrets/corporate-ca.pem ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/corporate-ca.pem; fi; \
    npm run build:backend \
    && node node_modules/typescript/bin/tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --experimentalDecorators --emitDecoratorMetadata --esModuleInterop --skipLibCheck --types node --rootDir . --outDir dist scripts/migrate.ts

FROM node:24-bookworm-slim AS busca-build
WORKDIR /app/app-busca
COPY app-busca/package.json app-busca/package-lock.json ./
RUN npm ci
COPY app-busca/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=staging
ENV NEST_BOOTSTRAP=1
ENV ONBOARDING_MODE=staging
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=backend-build --chown=node:node /app/dist ./dist
COPY --from=backend-build --chown=node:node /app/prisma ./prisma
COPY --from=backend-build --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY --from=busca-build --chown=node:node /app/app-busca/dist ./app-busca/dist
COPY --from=busca-build --chown=node:node /app/app-busca/node_modules ./app-busca/node_modules
COPY db ./dist/db
COPY --chown=node:node data/geo ./data/geo
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4500
CMD ["node", "dist/src/main.js"]

# Worker publishes the same revision with its browser runtime and dependencies.
FROM runtime AS worker
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN node node_modules/playwright-core/cli.js install --with-deps chromium \
    && chown -R node:node /home/node/.cache/ms-playwright \
    && rm -rf /var/lib/apt/lists/*
USER node
CMD ["node", "dist/src/queue/worker.js"]

FROM runtime AS web

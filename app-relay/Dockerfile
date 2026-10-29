ARG NODE_RUNTIME_IMAGE=public-runtime
FROM amd64/node:24.22.1-trixie-slim@sha256:c01213220866886d4ddaf3e7d5a303259d0af1fdfbed490c1c72c46279fa6c1f AS public-runtime
RUN apt-get update && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_OPTIONS=--use-openssl-ca \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt SSL_CERT_DIR=/etc/ssl/certs

FROM ${NODE_RUNTIME_IMAGE} AS build
WORKDIR /src/app-relay
RUN npm install -g pnpm@11.15.1
COPY app-relay/package.json app-relay/pnpm-lock.yaml app-relay/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
WORKDIR /src/lib-orchestrator
COPY lib-orchestrator/package.json lib-orchestrator/pnpm-lock.yaml lib-orchestrator/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY lib-orchestrator/ ./
COPY app-host/app/wire/ /src/app-host/app/wire/
WORKDIR /src/app-relay
COPY app-relay/start.ts app-relay/tsconfig.json app-relay/build.mjs ./
COPY app-relay/app/ ./app/
COPY app-relay/web/ ./web/
RUN pnpm typecheck && pnpm build && pnpm prune --prod

FROM ${NODE_RUNTIME_IMAGE}
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=build /src/app-relay/node_modules ./node_modules
COPY --from=build /src/app-relay/dist/start.js ./start.js
COPY app-relay/package.json ./
COPY --from=build /src/app-relay/dist/web ./web/
ARG RELAY_CONFIG=app-relay/config.example.json
COPY --chown=node:node ${RELAY_CONFIG} /config/config-remote.json
ENV JAMAT_V3_RELAY_CONFIG=/config/config-remote.json
ENV JAMAT_V3_RELAY_PORT=8080
EXPOSE 8080
USER node
ARG BUILD_TIME
ENV JAMAT_V3_RELAY_BUILD_TIME=${BUILD_TIME}
CMD ["node", "start.js"]

# Shared runtime base 2.0.1 (Q:/Docker/Docker, r419): patched OS, CA store and CA environment.
# The base has no Corepack, so pnpm comes from npm at the version of packageManager.
FROM registry.dockerserver.sbs/node-runtime@sha256:7b8e2dc4b4510ab8346e9ac7a6dffb45da007eebbef71b572800292fc65ce079 AS build
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

FROM registry.dockerserver.sbs/node-runtime@sha256:7b8e2dc4b4510ab8346e9ac7a6dffb45da007eebbef71b572800292fc65ce079
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=build /src/app-relay/node_modules ./node_modules
COPY --from=build /src/app-relay/dist/start.js ./start.js
COPY app-relay/package.json ./
COPY --from=build /src/app-relay/dist/web ./web/
COPY --chown=node:node app-relay/.private/config-remote.json /config/config-remote.json
ENV JAMAT_V3_RELAY_CONFIG=/config/config-remote.json
ENV JAMAT_V3_RELAY_PORT=8080
EXPOSE 8080
USER node
ARG BUILD_TIME
ENV JAMAT_V3_RELAY_BUILD_TIME=${BUILD_TIME}
CMD ["node", "start.js"]

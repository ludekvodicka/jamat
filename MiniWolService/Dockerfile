# Shared runtime base 2.0.1 (Q:/Docker/Docker, r419): patched OS, CA store and CA environment.
FROM registry.dockerserver.sbs/node-runtime@sha256:7b8e2dc4b4510ab8346e9ac7a6dffb45da007eebbef71b572800292fc65ce079
WORKDIR /app
COPY --chown=node:node package.json start.mjs server.mjs wol.mjs launcher.mjs pairing.mjs web.css ./
USER node
CMD ["node", "start.mjs"]
ARG BUILD_TIME
RUN test -n "$BUILD_TIME"
ENV APP_BUILD_TIME=${BUILD_TIME} JAMAT_V3_WOL_BUILD_TIME=${BUILD_TIME}

ARG NODE_RUNTIME_IMAGE=public-runtime
FROM amd64/node:24.22.1-trixie-slim@sha256:c01213220866886d4ddaf3e7d5a303259d0af1fdfbed490c1c72c46279fa6c1f AS public-runtime
RUN apt-get update && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_OPTIONS=--use-openssl-ca \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt SSL_CERT_DIR=/etc/ssl/certs

FROM ${NODE_RUNTIME_IMAGE}
WORKDIR /app
COPY --chown=node:node package.json start.mjs server.mjs wol.mjs launcher.mjs pairing.mjs web.css ./
USER node
CMD ["node", "start.mjs"]
ARG BUILD_TIME
RUN test -n "$BUILD_TIME"
ENV APP_BUILD_TIME=${BUILD_TIME} JAMAT_V3_WOL_BUILD_TIME=${BUILD_TIME}

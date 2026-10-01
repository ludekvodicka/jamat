FROM node:22.23.2-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json start.mjs server.mjs wol.mjs launcher.mjs pairing.mjs web.css ./
USER node
CMD ["node", "start.mjs"]
ARG BUILD_TIME
RUN test -n "$BUILD_TIME"
ENV APP_BUILD_TIME=${BUILD_TIME} JAMAT_V3_WOL_BUILD_TIME=${BUILD_TIME}

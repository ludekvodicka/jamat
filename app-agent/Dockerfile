FROM node:20-alpine AS build

WORKDIR /app

RUN npm init -y && npm install tsx@4

COPY remote-server.ts wol.ts ./

RUN npx esbuild remote-server.ts --bundle --platform=node --format=esm --outfile=dist/server.mjs

FROM node:20-alpine

WORKDIR /app

COPY --from=build /app/dist/server.mjs ./server.mjs
COPY web/ ./web/

# config-remote.json (PC registry + machine keys = RCE creds) lives in app-agent/, GIT-IGNORED — it
# never reaches the public repo, but it IS baked into the image (we push to a PRIVATE registry).
# Public self-hosters `cp config-remote.example.json config-remote.json` before building. Mountable
# at runtime to override (see docker-compose.example.yml).
COPY config-remote.json /config/config-remote.json
ENV REMOTE_CONFIG=/config/config-remote.json
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.mjs"]

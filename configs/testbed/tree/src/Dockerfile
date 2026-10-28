# Recognised by FILENAME, not by extension.
FROM amd64/node:24.22.1-trixie-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM amd64/node:24.22.1-trixie-slim
WORKDIR /app
COPY --from=build /app/out ./out
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "out/start.js"]

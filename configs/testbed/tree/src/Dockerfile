# Recognised by FILENAME, not by extension.
FROM node:22.16.0-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22.16.0-alpine
WORKDIR /app
COPY --from=build /app/out ./out
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "out/start.js"]

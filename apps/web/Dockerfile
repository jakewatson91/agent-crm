# Self-host Dockerfile for the Next.js web app.
# Builds the whole pnpm monorepo (workspace packages are transpiled by Next.js
# via transpilePackages) and runs `pnpm --filter web start`.
#
# Build context = repo root (see docker-compose.yml).
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@11.0.9 --activate

WORKDIR /app

# Copy everything. Multi-stage caching for monorepos is fiddly because of
# transitive workspace deps; single-stage is fine for v1.
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter web build

EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production

CMD ["pnpm", "--filter", "web", "start"]

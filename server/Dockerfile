# PayPilot AI backend image.
#
# Stages:
#   build    - installs all dependencies from package-lock.json and compiles
#              TypeScript. CI also uses this stage to run the tests inside
#              the image (docker build --target build).
#   prod-deps - the same node_modules without development dependencies.
#   runtime  - what Render runs: compiled code and production dependencies
#              only, as the unprivileged "node" user.
#
# No .env file or secret is copied in (see .dockerignore); configuration
# comes from the platform's environment variables at run time.

FROM node:22-bookworm-slim AS build

WORKDIR /app

# Compilers for native modules: better-sqlite3 (a development dependency used
# only by the unit tests) builds from source. It is pruned in prod-deps, so
# the runtime image does not contain it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM build AS prod-deps
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/package.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node

EXPOSE 4000

# Liveness only: /api/health calls no outside service.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Node runs as PID 1 so it receives SIGTERM directly and can drain requests
# (see gracefulShutdown.ts); npm would sit in between.
CMD ["node", "dist/index.js"]

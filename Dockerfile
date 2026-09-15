# syntax=docker/dockerfile:1

# FleetTrack API — NestJS 11 + Prisma 6, PostgreSQL (Neon) over the network.
#
# Base is node:22-slim (Debian/glibc), NOT alpine, and that is deliberate:
# prisma/schema.prisma declares `generator client` with no `binaryTargets`, so Prisma
# resolves the engine as "native" — whatever libc it was generated against. Alpine (musl)
# would need `binaryTargets = ["linux-musl-openssl-3.0.x"]` added to the schema, and the
# schema is out of scope. Keeping BOTH stages on the same Debian base makes "native"
# correct by construction. For the same reason node_modules is never copied from the host
# (it holds a Windows engine) — .dockerignore excludes it and every stage installs fresh.

########################  build stage  ########################
FROM node:22-slim AS build

WORKDIR /app

# Prisma's query engine and CLI need OpenSSL.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first so this layer caches across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

# `npm run build` = rimraf dist && prisma generate && nest build, so prisma/ must be
# present before it runs — generate happens HERE, inside Linux, not on the host.
COPY prisma ./prisma
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN npm run build

########################  runtime stage  ######################
FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# node_modules is carried over WHOLE rather than pruned with `npm prune --omit=dev`.
# The Prisma CLI is a devDependency but is required at RUNTIME by `prisma migrate deploy`
# in the CMD below; pruning would delete it and every container start would fail. Moving
# prisma into `dependencies` would mean editing package.json, which is out of scope for
# this step. The cost is image size, not correctness — revisit if size ever matters.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# prisma/ is needed at runtime too: `migrate deploy` reads schema.prisma + migrations/.
COPY --from=build /app/prisma ./prisma

# UPLOAD_DIR target. Created here so the app works even with no volume attached; in
# production this path is bind-mounted to persistent host storage, and that host
# directory must be owned by uid 1000 (the `node` user) or uploads will fail with EACCES.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

# Drop root. Everything above is owned by root and only read by the app.
USER node

EXPOSE 5000

# Liveness against the existing public endpoint from STEP 3 — no second health route, and
# no curl/wget dependency: Node 22 has global fetch built in.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run at CONTAINER START, never at image build — the image must not need a
# database to build, and DATABASE_URL is a runtime secret. Safe for this project: all 25
# migrations are additive (no DROP TABLE/COLUMN, no TRUNCATE, no DELETE) and
# `migrate deploy` is idempotent, applying only what is pending.
#
# The retry exists because Neon scales its compute to zero when idle: the FIRST
# connection after an idle period fails with P1001 while the compute wakes, and a retry
# seconds later succeeds. Without this, a deploy onto a cold database fails, and
# `restart: unless-stopped` turns that into a restart loop.
#
# Bounded at 10 attempts x 5s (~50s, comfortably longer than a Neon cold start). If it
# still fails the container EXITS NON-ZERO rather than starting the app against a
# database whose schema was never verified. `exec` hands PID 1 to node so SIGTERM
# reaches it and graceful shutdown is preserved.
CMD ["sh", "-c", "n=0; until npx prisma migrate deploy; do n=$((n+1)); if [ $n -ge 10 ]; then echo \"FATAL: prisma migrate deploy failed after $n attempts\"; exit 1; fi; echo \"migrate deploy attempt $n failed (database may be waking) - retrying in 5s\"; sleep 5; done; exec node dist/main.js"]

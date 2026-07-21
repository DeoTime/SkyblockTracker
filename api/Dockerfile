# Mirrors ingest/Dockerfile: better-sqlite3 is native, so compile it in a
# throwaway stage and ship a runtime image with no compilers on it.
FROM node:22-bookworm-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER node

ENV NODE_ENV=production \
    DB_PATH=/data/skyblock.db \
    PORT=4000

EXPOSE 4000

# Healthy = the DB opens and the route layer answers. This deliberately does
# NOT check ingest freshness: the API is still correctly serving history when
# the ingest is down, and coupling them would restart a working container.
HEALTHCHECK --interval=60s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]

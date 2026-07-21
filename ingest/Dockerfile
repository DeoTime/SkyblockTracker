# better-sqlite3 is a native module, so build it in a throwaway stage and ship
# only the compiled result — the runtime image gets no compilers.
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

# Run unprivileged, and own /data so the volume is writable.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENV NODE_ENV=production \
    DB_PATH=/data/skyblock.db

# Healthy = the ended-auctions poller wrote a log row in the last 3 minutes.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "import('better-sqlite3').then(async m=>{const d=new m.default(process.env.DB_PATH,{readonly:true});const r=d.prepare(\"SELECT MAX(ts) t FROM ingest_log WHERE kind='ended'\").get();process.exit(r&&Date.now()-r.t<180000?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]

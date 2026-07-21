#!/usr/bin/env bash
# Deploy the read API alongside the ingest on the Chicago host.
#
# Same shape as ingest/deploy.sh: plain `docker`, because that box has Docker
# 26.1.3 with no compose plugin and it also runs nerfchess — not a server to
# install packages on casually.
#
# Prerequisite (interactive, Cloudflare Access — cannot be scripted):
#   cloudflared access login https://ssh-chicago.nerfchess.com
#
# Usage:  ./deploy.sh [ssh-host]      default host: nerfchess
#
# ADMIN_PASSWORD gates POST /api/key, the only write endpoint. It is read from
# the environment and never stored in this repo:
#
#   ADMIN_PASSWORD='…' ./deploy.sh nerfchess
#
# Leaving it unset FAILS CLOSED — /api/key returns 503 and no key can be
# installed. That is the safe default for a routine redeploy, but it also means
# a redeploy without it turns key updates off until you pass it again.
set -euo pipefail

HOST="${1:-nerfchess}"
REMOTE_DIR="~/skyblock-api"
NAME="skyblock-api"

# Loopback ONLY. The box has no firewall in front of it and already serves
# production traffic; publishing 4000 to the world would expose this without
# anyone asking for it. Reach it with `ssh -L`, or put a tunnel in front
# (./tunnel.sh) — never by changing this to 0.0.0.0.
BIND="${BIND:-127.0.0.1}"
PORT="${PORT:-4000}"

echo "==> packaging (excluding node_modules — host is aarch64, native module)"
tar czf /tmp/skyblock-api.tar.gz --exclude=node_modules -C "$(dirname "$0")/.." api
scp -q /tmp/skyblock-api.tar.gz "$HOST:/tmp/skyblock-api.tar.gz"
ssh "$HOST" "mkdir -p $REMOTE_DIR && tar xzf /tmp/skyblock-api.tar.gz -C $REMOTE_DIR --strip-components=1 && rm /tmp/skyblock-api.tar.gz"
rm -f /tmp/skyblock-api.tar.gz

echo "==> building image (better-sqlite3 compiles from source on ARM; ~3 min)"
ssh "$HOST" "cd $REMOTE_DIR && docker build -t ${NAME}:latest ."

echo "==> replacing container"
ssh "$HOST" "docker rm -f ${NAME} >/dev/null 2>&1 || true"

# The volume is mounted read-WRITE even though the DB is opened readonly: a WAL
# reader has to create and map the -shm file, and :ro makes every query fail
# with SQLITE_CANTOPEN. Read-only-ness is enforced in the connection, not here.
ssh "$HOST" "docker run -d \
  --name ${NAME} \
  --restart unless-stopped \
  --network skyblock-net \
  -v skyblock-data:/data \
  -p ${BIND}:${PORT}:4000 \
  -e DB_PATH=/data/skyblock.db \
  -e SETTINGS_PATH=/data/settings.db \
  -e CORS_ORIGIN='${CORS_ORIGIN:-*}' \
  -e ADMIN_PASSWORD='${ADMIN_PASSWORD:-}' \
  -e TZ=UTC \
  --memory 512m \
  --cpus 0.5 \
  --pids-limit 128 \
  --security-opt no-new-privileges:true \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
  ${NAME}:latest"

echo "==> waiting for health"
ssh "$HOST" 'n=0; until [ "$(docker inspect -f "{{.State.Health.Status}}" skyblock-api)" = healthy ] || [ $n -ge 20 ]; do n=$((n+1)); sleep 3; done; docker inspect -f "health: {{.State.Health.Status}}" skyblock-api'
ssh "$HOST" "curl -fsS http://${BIND}:${PORT}/api/health && echo"

cat <<EOF

deployed, listening on ${BIND}:${PORT} of the host only.

  reach it locally:  ssh -L 4000:${BIND}:${PORT} $HOST
                     curl localhost:4000/api/health
  logs:              ssh $HOST 'docker logs -f ${NAME}'
  publish it:        ./tunnel.sh $HOST   (Cloudflare Tunnel, no open ports)
EOF

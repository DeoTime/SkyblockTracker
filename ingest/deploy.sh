#!/usr/bin/env bash
# Deploy the ingest to the Chicago host.
#
# Uses plain `docker` rather than compose: that box has Docker 26.1.3 with NO
# compose plugin, and installing one would mean adding packages to a server
# already running nerfchess. The flags below reproduce docker-compose.yml
# exactly, so either path yields the same container.
#
# Prerequisite (interactive, cannot be scripted — Cloudflare Access):
#   cloudflared access login https://ssh-chicago.nerfchess.com
#
# Usage:  ./deploy.sh [ssh-host]      default host: nerfchess
set -euo pipefail

HOST="${1:-nerfchess}"
REMOTE_DIR="~/skyblock-ingest"
NAME="skyblock-ingest"

TRACKED="${TRACKED_UUIDS:-826bf8088bf9406a88b1bf2242f1d317,b7e55bf27a754acc9f105cb5472a6997}"

echo "==> packaging (excluding node_modules — host is aarch64)"
tar czf /tmp/ingest.tar.gz \
  --exclude=node_modules --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
  -C "$(dirname "$0")/.." ingest

echo "==> uploading to $HOST"
scp -q /tmp/ingest.tar.gz "$HOST:/tmp/ingest.tar.gz"
ssh "$HOST" "mkdir -p $REMOTE_DIR && tar xzf /tmp/ingest.tar.gz -C $REMOTE_DIR --strip-components=1 && rm /tmp/ingest.tar.gz"
rm -f /tmp/ingest.tar.gz

echo "==> building image (better-sqlite3 compiles from source on ARM; ~3 min)"
ssh "$HOST" "cd $REMOTE_DIR && docker build -t ${NAME}:latest ."

echo "==> ensuring isolated network and volume"
ssh "$HOST" "docker network create skyblock-net >/dev/null 2>&1 || true; docker volume create skyblock-data >/dev/null 2>&1 || true"

echo "==> replacing container (the named volume survives, so no data is lost)"
ssh "$HOST" "docker rm -f ${NAME} >/dev/null 2>&1 || true"

ssh "$HOST" "docker run -d \
  --name ${NAME} \
  --restart unless-stopped \
  --network skyblock-net \
  -v skyblock-data:/data \
  -e TRACKED_UUIDS=${TRACKED} \
  -e ENDED_INTERVAL_MS=20000 \
  -e BAZAAR_INTERVAL_MS=60000 \
  -e DB_PATH=/data/skyblock.db \
  -e TZ=UTC \
  --memory 512m \
  --cpus 0.5 \
  --pids-limit 128 \
  --security-opt no-new-privileges:true \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
  ${NAME}:latest"

echo "==> waiting for first poll"
ssh "$HOST" 'n=0; until [ "$(docker logs skyblock-ingest 2>&1 | grep -c "ended:")" -ge 1 ] || [ $n -ge 20 ]; do n=$((n+1)); sleep 3; done'
ssh "$HOST" "docker logs ${NAME} 2>&1 | tail -8"

echo
echo "deployed. useful commands:"
echo "  ssh $HOST 'docker logs -f ${NAME}'"
echo "  ssh $HOST 'docker exec ${NAME} npm run --silent stats'"

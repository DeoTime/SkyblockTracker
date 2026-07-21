#!/usr/bin/env bash
# Publish the read API through a Cloudflare Tunnel.
#
# Why a tunnel and not a published port: cloudflared dials OUT to Cloudflare, so
# nothing inbound is opened on a box that is already serving nerfchess and
# postgres16. The API container stays bound to 127.0.0.1.
#
# One-time setup, in the Cloudflare dashboard (you must do this — it needs your
# account, and I should not be authenticating as you):
#
#   1. Zero Trust -> Networks -> Tunnels -> Create a tunnel -> Cloudflared
#   2. Name it e.g. skyblock-api. Copy the connector TOKEN it shows you.
#   3. Under "Public Hostnames", add:
#        subdomain: api                 domain: wwolf.shop
#        service:   http://skyblock-api:4000
#      "skyblock-api" there is the CONTAINER name on skyblock-net, which is why
#      cloudflared has to join that network below. Cloudflare creates the DNS
#      record for api.wwolf.shop itself.
#   4. Do NOT put an Access policy on this hostname. Access answers with an SSO
#      redirect, and a browser fetch() from the site cannot complete one — every
#      dashboard would fail to load. ssh-chicago is gated; this must not be.
#
# Then:  TUNNEL_TOKEN=eyJ... ./tunnel.sh [ssh-host]
#
# The token is a credential. It is passed through the environment and never
# written to a file in this repo — do not paste it into one.
set -euo pipefail

HOST="${1:-nerfchess}"
NAME="skyblock-tunnel"

if [ -z "${TUNNEL_TOKEN:-}" ]; then
  echo "TUNNEL_TOKEN is not set. See the header of this script for how to get one." >&2
  exit 1
fi

echo "==> replacing $NAME"
ssh "$HOST" "docker rm -f ${NAME} >/dev/null 2>&1 || true"

# The token is passed over the ssh channel and lands only in the container's
# environment on the remote host. Nothing writes it to disk here.
ssh "$HOST" "docker run -d \
  --name ${NAME} \
  --restart unless-stopped \
  --network skyblock-net \
  -e TUNNEL_TOKEN='${TUNNEL_TOKEN}' \
  --memory 256m \
  --pids-limit 64 \
  --security-opt no-new-privileges:true \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  cloudflare/cloudflared:latest tunnel --no-autoupdate run"

sleep 5
ssh "$HOST" "docker logs ${NAME} 2>&1 | tail -12"

cat <<EOF

If the log shows "Registered tunnel connection", it is live at the public
hostname you configured in step 3.

Then point the frontend at it and turn the mocks off:

  # Workers Builds -> build configuration -> Build variables
  VITE_USE_MOCKS=false
  VITE_API_BASE_URL=https://api.wwolf.shop/api

VITE_* is substituted at BUILD time, so a rebuild is required — setting it in
Settings -> Variables & Secrets does nothing for a static-assets Worker.
EOF

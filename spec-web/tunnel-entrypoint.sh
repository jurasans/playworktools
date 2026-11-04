#!/bin/sh
# Wraps cloudflared so the public URL is actually easy to find, and supports
# two modes:
#
#   named  — a real, permanent domain (TUNNEL_ID + TUNNEL_HOSTNAME +
#            /etc/cloudflared/creds.json mounted in). The hostname is known
#            upfront, so nothing needs to be grepped out of a log at all.
#   quick  — the default: an anonymous, no-account *.trycloudflare.com
#            hostname that's random on every restart.
#
# Either way, the official cloudflare/cloudflared image is scratch-based (no
# shell, no grep) and cloudflared itself only prints its URL/status ONCE,
# ahead of a wall of connectivity-precheck lines — easy to lose in
# `docker logs`. This entrypoint (run from an alpine base with the binary
# copied in, see Dockerfile.tunnel) re-announces it on a timer instead, and
# drops it in a plain file so it can be grabbed with a single `docker exec`
# and no log-scrolling at all.
set -eu

LOG=/tmp/cloudflared.log
URL_FILE=/tmp/tunnel-url.txt
MODE="${TUNNEL_MODE:-quick}"

if [ "$MODE" = "named" ]; then
  : "${TUNNEL_ID:?TUNNEL_MODE=named requires TUNNEL_ID}"
  : "${TUNNEL_HOSTNAME:?TUNNEL_MODE=named requires TUNNEL_HOSTNAME}"
  TARGET="${TUNNEL_TARGET:-http://spec-web:8888}"
  CFG=/tmp/config.yml
  cat > "$CFG" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: /etc/cloudflared/creds.json
ingress:
  - hostname: ${TUNNEL_HOSTNAME}
    service: ${TARGET}
  - service: http_status:404
EOF
  cloudflared tunnel --config "$CFG" run "$@" 2>&1 | tee "$LOG" &
else
  TARGET="${TUNNEL_TARGET:-http://spec-web:8888}"
  cloudflared tunnel --url "$TARGET" --no-autoupdate "$@" 2>&1 | tee "$LOG" &
fi
CF_PID=$!

(
  if [ "$MODE" = "named" ]; then
    # The hostname is already known — just wait for a real connection to
    # register before declaring it live, rather than grepping for anything.
    while ! grep -q 'Registered tunnel connection' "$LOG" 2>/dev/null; do sleep 1; done
    URL="https://${TUNNEL_HOSTNAME}"
  else
    URL=""
    while [ -z "$URL" ]; do
      URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "$LOG" | head -1 || true)
      [ -z "$URL" ] && sleep 1
    done
  fi

  # spec-web now gates access with a username/password sign-in (see
  # server.mjs's /login) rather than a per-restart random token embedded in
  # the URL, so there is no secret to fetch/relay here anymore — the tunnel
  # just needs to announce the base URL, and /login itself as the concrete
  # entry point people should actually be handed.
  LOGIN_URL="$URL/login"
  DL_URL="$URL/download"
  echo "$LOGIN_URL" > "$URL_FILE"

  while kill -0 "$CF_PID" 2>/dev/null; do
    echo ""
    echo "================================================================"
    echo "  MODE: $MODE"
    echo "  SPEC TOOL (private, sign in): $LOGIN_URL"
    echo "  DEBUG BUILD (public, password-protected): $DL_URL"
    echo "  also readable any time via:"
    echo "  docker exec playwork-spec-tunnel cat $URL_FILE"
    echo "================================================================"
    sleep 60
  done
) &

wait "$CF_PID"

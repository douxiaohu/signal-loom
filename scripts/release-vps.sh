#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DEPLOY_HOST:-racknerd-vps}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT_DIR"

echo "Connecting to ${HOST}..."
APP_DIR="$(ssh -o BatchMode=yes -o ConnectTimeout=25 "$HOST" 'bash -s' <<'REMOTE'
set +e
docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    sudo -n docker "$@"
    return
  fi
  return 1
}

for name in telegram-forwarder telegram-github-radar radar; do
  dir="$(docker_cmd inspect "$name" --format "{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}" 2>/dev/null)"
  if [[ -n "$dir" && "$dir" != "<no value>" ]]; then
    printf "%s\n" "$dir"
    exit 0
  fi
  dir="$(docker_cmd inspect "$name" --format "{{range .Mounts}}{{if eq .Destination \"/app/data\"}}{{.Source}}{{end}}{{end}}" 2>/dev/null)"
  if [[ -n "$dir" ]]; then
    printf "%s\n" "$(dirname "$dir")"
    exit 0
  fi
done

while IFS= read -r file; do
  if grep -Eq "telegram-forwarder|telegram-github-radar" "$file" 2>/dev/null; then
    dirname "$file"
    exit 0
  fi
done < <(find /opt /home /srv /root /var/www /data -maxdepth 6 \( -name docker-compose.yml -o -name compose.yml \) 2>/dev/null)

while IFS= read -r file; do
  printf "%s\n" "$(dirname "$(dirname "$file")")"
  exit 0
done < <(find /opt /home /srv /root /var/www /data -maxdepth 6 -name telegram_forwarder.db 2>/dev/null)

echo "DEBUG docker:" >&2
docker_cmd ps -a --format "{{.Names}} {{.Image}} {{.Status}}" >&2
echo "DEBUG compose files:" >&2
find /opt /home /srv /root /var/www /data -maxdepth 6 \( -name docker-compose.yml -o -name compose.yml \) 2>/dev/null >&2
exit 1
REMOTE
)"

if [[ -z "${APP_DIR}" || "${APP_DIR}" == "<no value>" ]]; then
  echo "Could not find the production app directory on ${HOST}." >&2
  echo "Run this and paste the output:" >&2
  echo "  ssh ${HOST} 'sudo docker ps -a; echo ---; sudo find /opt /home /srv /root /var/www /data -maxdepth 6 \\( -name docker-compose.yml -o -name telegram_forwarder.db -o -name .env \\) 2>/dev/null'" >&2
  exit 1
fi

echo "App directory: ${APP_DIR}"
BACKUP_DIR="/opt/backups/telegram-forwarder/${STAMP}"

echo "Backing up ${APP_DIR} to ${BACKUP_DIR}..."
ssh -o BatchMode=yes "$HOST" bash -s -- "$APP_DIR" "$BACKUP_DIR" "$STAMP" <<'REMOTE'
set -euo pipefail
APP_DIR="$1"
BACKUP_DIR="$2"
STAMP="$3"
mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"
if [[ -f data/telegram_forwarder.db ]]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 data/telegram_forwarder.db ".backup '$BACKUP_DIR/telegram_forwarder.db'"
  else
    cp -a data/telegram_forwarder.db "$BACKUP_DIR/telegram_forwarder.db"
  fi
fi
if [[ -d data ]]; then
  tar -czf "$BACKUP_DIR/data.tgz" data || {
    status=$?
    if [[ "$status" -ne 1 ]]; then
      exit "$status"
    fi
  }
fi
[[ -f .env ]] && cp -a .env "$BACKUP_DIR/env"
[[ -f config/groups.yaml ]] && cp -a config/groups.yaml "$BACKUP_DIR/groups.yaml"
if docker image inspect telegram-forwarder >/dev/null 2>&1; then
  docker tag telegram-forwarder "telegram-forwarder:pre-${STAMP}" || true
fi
echo "$BACKUP_DIR"
REMOTE

echo "Ensuring rsync exists on ${HOST}..."
ssh -o BatchMode=yes "$HOST" 'command -v rsync >/dev/null || (export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y rsync)'

echo "Syncing v1.0.0 source (keeping remote .env, data, and groups.yaml)..."
RSYNC_EXCLUDES=(
  --exclude '.git/'
  --exclude '.venv/'
  --exclude 'venv/'
  --exclude '__pycache__/'
  --exclude '.pytest_cache/'
  --exclude 'node_modules/'
  --exclude 'frontend/node_modules/'
  --exclude 'frontend/dist/'
  --exclude 'frontend/test-results/'
  --exclude 'frontend/playwright-report/'
  --exclude '.env'
  --exclude 'data/'
  --exclude 'bin/'
  --exclude 'config/groups.yaml'
  --exclude '.DS_Store'
  --exclude '.grok/'
)
if ssh -o BatchMode=yes "$HOST" 'command -v rsync >/dev/null'; then
  rsync -az --delete "${RSYNC_EXCLUDES[@]}" "$ROOT_DIR/" "${HOST}:${APP_DIR}/"
else
  echo "rsync still missing; falling back to tar over SSH."
  COPYFILE_DISABLE=1 tar -C "$ROOT_DIR" \
    --exclude '.git' \
    --exclude '.venv' \
    --exclude 'venv' \
    --exclude '__pycache__' \
    --exclude '.pytest_cache' \
    --exclude 'node_modules' \
    --exclude 'frontend/node_modules' \
    --exclude 'frontend/dist' \
    --exclude 'frontend/test-results' \
    --exclude 'frontend/playwright-report' \
    --exclude '.env' \
    --exclude 'data' \
    --exclude 'config/groups.yaml' \
    --exclude '.DS_Store' \
    --exclude '.grok' \
    -cf - . | ssh -o BatchMode=yes "$HOST" "tar -C $(printf '%q' "$APP_DIR") -xf -"
fi

echo "Rebuilding and restarting..."
ssh -o BatchMode=yes "$HOST" "set -euo pipefail
cd $(printf '%q' "$APP_DIR")
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --build
  docker compose ps
else
  docker-compose up -d --build
  docker-compose ps
fi
sleep 2
curl -fsS http://127.0.0.1:8000/health
echo
curl -fsS -o /dev/null -w 'GET / %{http_code}\n' http://127.0.0.1:8000/
curl -fsS -o /dev/null -w 'GET /admin %{http_code}\n' http://127.0.0.1:8000/admin
curl -sS -o /dev/null -w 'GET /api/admin/sources %{http_code}\n' http://127.0.0.1:8000/api/admin/sources
ss -lnt | grep 8000 || netstat -lnt | grep 8000 || true
"

echo
echo "Deploy finished. Backup: ${BACKUP_DIR}"
echo "If health checks look wrong, restore data from that backup and retag telegram-forwarder:pre-${STAMP}."

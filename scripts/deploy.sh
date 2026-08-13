#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env and fill runtime values first." >&2
  exit 1
fi

if [[ ! -f config/groups.yaml ]]; then
  echo "Missing config/groups.yaml. Copy config/groups.example.yaml and fill webhook_url first." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  docker compose up -d --build
  docker compose ps
else
  docker-compose up -d --build
  docker-compose ps
fi

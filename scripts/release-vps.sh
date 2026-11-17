#!/usr/bin/env bash
# Compatibility entry: use the verified artifact deployer, never sync the working tree.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/release-vps.sh outputs/releases/<release>/release.tar.gz [release.py deploy options]" >&2
  exit 2
fi
exec python3 "$ROOT_DIR/scripts/release.py" deploy "$@"

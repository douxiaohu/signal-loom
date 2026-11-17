#!/usr/bin/env bash
set -euo pipefail
VERSION=8.30.1
DESTINATION="${1:-/tmp/signal-loom-tools}"
case "$(uname -s)" in Linux) PLATFORM=linux;; Darwin) PLATFORM=darwin;; *) echo 'Unsupported OS' >&2; exit 1;; esac
case "$(uname -m)" in x86_64) ARCH=x64;; arm64|aarch64) ARCH=arm64;; *) echo 'Unsupported architecture' >&2; exit 1;; esac
mkdir -p "$DESTINATION"
PACKAGE="gitleaks_${VERSION}_${PLATFORM}_${ARCH}.tar.gz"
BASE="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}"
curl -fsSL "$BASE/$PACKAGE" -o "$DESTINATION/$PACKAGE"
curl -fsSL "$BASE/gitleaks_${VERSION}_checksums.txt" -o "$DESTINATION/checksums.txt"
python3 - "$DESTINATION" "$PACKAGE" <<'PY'
import hashlib,sys,tarfile
from pathlib import Path
root=Path(sys.argv[1]);name=sys.argv[2]
expected=next(line.split()[0] for line in (root/'checksums.txt').read_text().splitlines() if line.split()[-1]==name)
assert hashlib.sha256((root/name).read_bytes()).hexdigest()==expected,'Gitleaks checksum mismatch'
with tarfile.open(root/name) as archive:
 member=archive.getmember('gitleaks');assert member.isfile()
 (root/'gitleaks').write_bytes(archive.extractfile(member).read())
(root/'gitleaks').chmod(0o755)
PY

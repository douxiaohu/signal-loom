# Contributing · 贡献指南

Signal Loom uses Go 1.27.4+, Node.js 22 and Python 3 for release tooling. The supported runtime is `cmd/server` + `internal/` + `frontend/`; `app/` and `tests/` retain the historical Python implementation.

1. Describe the user-visible problem and keep the change focused. Behavioral or cross-module decisions belong in `docs/architecture/notes/` alongside the code.
2. Keep public visibility checks consistent across lists, message permalinks and media. A private or disabled source must not become readable through saved IDs or direct links.
3. Never commit real keys, `.env`, runtime source configuration, databases, release packages, raw security reports or production visitor information. Demo screenshots use isolated API fixtures.
4. Add meaningful regression coverage for behavior changes. Styling and mechanical renames do not need tests that simply repeat the implementation.
5. Update the current architecture/operations reference when contracts change. Keep all four README editions aligned; public UI translations live in `frontend/src/translations.ts`.

Run before submitting:

```bash
go test -race ./...
go vet ./...
python3 -m unittest discover -s scripts/tests -v
python3 scripts/check-docs.py
npm --prefix frontend ci
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run test:e2e
```

Dependency checks:

```bash
go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
npm --prefix frontend audit --audit-level=high
bash scripts/install-gitleaks.sh
/tmp/signal-loom-tools/gitleaks git --redact=100 --config .gitleaks.toml --log-opts="--all --full-history"
```

The Gitleaks allowlist applies only to exact synthetic values in one configuration parser test. Do not exempt whole test directories or replace real credentials with an allowlist entry. See [security guidance](SECURITY.md).

To refresh demo screenshots, start the frontend on port 4190 and run the capture tool in another terminal:

```bash
npm --prefix frontend run dev -- --host 127.0.0.1 --port 4190
# Another terminal:
npm --prefix frontend run docs:screenshots
```

The tool intercepts all API requests with demonstration data. It does not log in to production. For deployment, use the [verified artifact workflow](docs/operations.md), not a working-tree sync.

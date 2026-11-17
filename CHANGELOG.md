# Changelog

## 2026-11-17 · Dependency branch consolidation

- Integrated all thirteen initial and follow-up dependency updates, preserving their original commits.
- Migrated to TypeScript 7, Vite 8 and React plugin 6; updated React, jsdom, Lucide and the testing libraries.
- Updated SQLite and GitHub Actions; aligned Node requirements with jsdom 31.
- Grouped compatible future dependency updates and retained separate review for major npm/Go upgrades.

## 2026-11-17 · Reading and operations

- Runtime site name, description and canonical origin through a public configuration whitelist.
- Local ID-only bookmarks, reading-position recovery and permission-checked message permalinks.
- QR codes and configured message URLs on paginated share images.
- Simplified Chinese, English, Japanese and Spanish public UI with lazy translation/QR bundles.
- Media-cache soft quota, retention, authenticated usage statistics and manual maintenance.
- Verified artifact release tool, online WAL-aware backups, isolated candidates and data-safe rollback.
- Standalone default Compose with an optional server network override.
- GitHub CI for tests, build budgets, package boundaries, dependency/secret checks and container builds.
- Patched Go toolchain and HTML parser; updated Vite/Vitest and vulnerable frontend transitive dependencies.
- Updated four-language illustrated guides, reproducible demo screenshots and current Go architecture.

## 2026-11-17 · Signal Loom identity

- Renamed the product to 拾讯 · Signal Loom and the repository to `douxiaohu/signal-loom`.
- Added MIT project licensing, third-party notices and sensitive-content documentation.
- Added the illustrated reading room and complete-media paginated sharing.

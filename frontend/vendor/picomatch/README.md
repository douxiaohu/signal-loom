# Signal Loom security patch of picomatch 4.0.7

This is a local, MIT-licensed build-time fork of [micromatch/picomatch](https://github.com/micromatch/picomatch), not an upstream release. Version: `4.0.7-signal-loom.1`.

Source: the npm `picomatch@4.0.7` distribution. `UPSTREAM-SHA256.json` records the original distribution file hashes. Runtime files are unchanged except for the guard in `lib/parse.js`; package metadata is reduced to runtime fields. The original copyright and license remain in `LICENSE`.

[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) affects upstream through 4.0.7. As of 2026-11-18, the advisory lists no patched release. This fork rejects **all `+(...)` and `*(...)` extglobs** at parser entry to those constructs, before generating a repeated regular expression. Rejection throws `ERR_UNSAFE_EXTGLOB`, including when `maxExtglobRecursion` is disabled. The restriction also rejects otherwise safe repeated extglobs. Ordinary `*`, `**`, braces, character classes, `@(...)`, `?(...)` and `!(...)` retain upstream behavior. Escaped and quoted patterns retain upstream behavior; `noextglob` continues to disable extglob parsing.

The root override directs Vite, Vitest, tinyglobby and fdir to this same fork. `npm audit` does not audit the contents of local packages, so a clean audit is **not** evidence that this patch works. `npm run test:security` separately checks installed dependency resolution, published attack patterns in timeout-bounded child processes, ordinary glob behavior, and the exact source delta from upstream. CI runs it before the application tests and build. This package is not part of the Go server or browser bundle.

When an upstream fix is available, remove the local dependency and override, install the fixed version, review the advisory and rerun security, application and browser tests. The fail-closed policy is documented in [the decision note](../../../docs/architecture/notes/implemented/bug-fix/2026-11-18-picomatch-redos-containment.md).

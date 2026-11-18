import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const pico = require('picomatch');
const fork = realpathSync(resolve(root, 'vendor/picomatch/index.js'));

test('all build and test consumers resolve the guarded local fork', () => {
  assert.equal(realpathSync(require.resolve('picomatch')), fork);
  for (const name of ['vite', 'vitest', 'tinyglobby', 'fdir']) {
    const consumer = createRequire(require.resolve(name));
    assert.equal(realpathSync(consumer.resolve('picomatch')), fork, name);
  }
  assert.equal(require('picomatch/package.json').version, '4.0.7-signal-loom.1');
});

test('attack patterns fail before regex execution in timeout-bounded processes', () => {
  // If a regression reintroduces catastrophic matching, only the child hangs.
  const script = String.raw`
    const assert = require('node:assert/strict');
    const pico = require('picomatch');
    const parse = require('picomatch/lib/parse');
    const patterns = ['+(*)', '+(*a)', '*(*)', '*(*a)', 'src/+(*a).js', '+(@(*a))', '+(a|aa)'];
    for (const options of [{}, {fastpaths:false}, {capture:true}, {maxExtglobRecursion:false}, {maxExtglobRecursion:100}]) {
      for (const pattern of patterns) {
        const rejected = (build) => assert.throws(() => {
          const matcher = build();
          if (typeof matcher === 'function') matcher('a'.repeat(64) + '!');
          else if (matcher instanceof RegExp) matcher.test('a'.repeat(64) + '!');
        }, {code:'ERR_UNSAFE_EXTGLOB'}, pattern);
        rejected(() => pico(pattern, options));
        rejected(() => pico.makeRe(pattern, options));
        rejected(() => pico.parse(pattern, options));
        rejected(() => parse(pattern, options));
        rejected(() => require('picomatch/posix')(pattern, options));
      }
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: root, timeout: 5000, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('normal source globs and nonrepeated extglobs retain matching behavior', () => {
  for (const [pattern, input, expected, options] of [
    ['src/**/*.{ts,tsx}', 'src/components/MessageCard.tsx', true],
    ['**/node_modules/**', 'frontend/node_modules/vite/index.js', true],
    ['src/**/*.test.ts', 'src/app.ts', false],
    ['**/[ab]?.ts', 'src/a1.ts', true],
    ['src/@(app|main).ts', 'src/main.ts', true],
    ['src/?(main).ts', 'src/main.ts', true],
    ['src/!(*.test).ts', 'src/main.ts', true],
    ['src/!(*.test).ts', 'src/main.test.ts', false],
    ['"+(*)"', '+(*)', true],
    ['\\+\\(\\*\\)', '+(*)', true],
    ['+(foo)', '+(foo)', true, {noextglob:true}],
  ]) assert.equal(pico(pattern, options)(input), expected, `${pattern}: ${input}`);
});

test('vendored runtime differs from upstream only by the reviewed parser guard', () => {
  const directory = resolve(root, 'vendor/picomatch');
  const manifest = JSON.parse(readFileSync(resolve(directory, 'UPSTREAM-SHA256.json')));
  const patch = `    // Signal Loom security patch for GHSA-fc5q-39xc-vjpf. Reject repeated
    // extglobs before emitting a regex; upstream's branch analysis misses
    // single-branch wildcard repetition. This guard cannot be opted out of.
    if (type === 'plus' || type === 'star') {
      const error = new SyntaxError('Repeated extglobs are disabled by the Signal Loom security patch');
      error.code = 'ERR_UNSAFE_EXTGLOB';
      throw error;
    }

`;
  for (const [name, sha] of Object.entries(manifest)) {
    if (name === 'package.json' || name === 'README.md') continue;
    let source = readFileSync(resolve(directory, name));
    if (name === 'lib/parse.js') {
      const text = source.toString();
      assert.equal(text.split(patch).length, 2, 'exactly one parser guard');
      source = Buffer.from(text.replace(patch, ''));
    }
    assert.equal(createHash('sha256').update(source).digest('hex'), sha, name);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const paths = {
  unified: new URL('../.github/workflows/schwab-sdk-ci.yml', import.meta.url),
  deep: new URL('../.github/workflows/schwab-deep-ci.yml', import.meta.url),
  script: new URL('../scripts/check-repository-invariants.sh', import.meta.url),
};

test('unified and deep CI share one repository invariant entrypoint', async () => {
  const [unified, deep] = await Promise.all([
    readFile(paths.unified, 'utf8'),
    readFile(paths.deep, 'utf8'),
  ]);
  const invocation = 'run: bash scripts/check-repository-invariants.sh';
  assert.match(unified, new RegExp(invocation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(deep, new RegExp(invocation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  for (const duplicatedImplementationDetail of [
    'temporary one-shot workflow remains in the repository',
    'temporary mechanical patch script remains in the repository',
    'stale nested SDK path remains',
    'unlocked Knip invocation remains',
  ]) {
    assert.equal(unified.includes(duplicatedImplementationDetail), false);
    assert.equal(deep.includes(duplicatedImplementationDetail), false);
  }
});

test('shared repository invariant script retains the permanent safety guards', async () => {
  const source = await readFile(paths.script, 'utf8');
  for (const contract of [
    'set -euo pipefail',
    'git diff --check',
    'test ! -d vendor',
    "-name '*-once.yml'",
    "-name '*-once.yaml'",
    "-name 'patch-*.py'",
    'scripts/enterprise-convergence-edit.mjs',
    'scripts/enterprise-finish-edit.mjs',
    'vendor/schwab-api-nodejs',
    'npx --yes kn',
  ]) {
    assert.equal(source.includes(contract), true, `missing invariant contract: ${contract}`);
  }
});

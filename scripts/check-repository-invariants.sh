#!/usr/bin/env bash
set -euo pipefail

git diff --check

test ! -d vendor

if find .github/workflows -maxdepth 1 -type f \( -name '*-once.yml' -o -name '*-once.yaml' \) -print -quit | grep -q .; then
  echo 'temporary one-shot workflow remains in the repository' >&2
  find .github/workflows -maxdepth 1 -type f \( -name '*-once.yml' -o -name '*-once.yaml' \) -print >&2
  exit 1
fi

if find scripts -type f -name 'patch-*.py' -print -quit | grep -q .; then
  echo 'temporary mechanical patch script remains in the repository' >&2
  find scripts -type f -name 'patch-*.py' -print >&2
  exit 1
fi

test ! -e scripts/enterprise-convergence-edit.mjs
test ! -e scripts/enterprise-finish-edit.mjs

if git grep -n 'vendor/schwab-api-nodejs' -- src test docs README.md package.json package-lock.json; then
  echo 'stale nested SDK path remains' >&2
  exit 1
fi

forbidden="npx --yes kn""ip"
if git grep -n -F "$forbidden" -- .github package.json; then
  echo 'unlocked Knip invocation remains' >&2
  exit 1
fi

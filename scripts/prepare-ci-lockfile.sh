#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <base-sha> <head-sha>" >&2
  exit 1
fi

base_sha="$1"
head_sha="$2"

for sha in "$base_sha" "$head_sha"; do
  if ! git cat-file -e "${sha}^{commit}" >/dev/null 2>&1; then
    echo "Missing commit $sha. Ensure the workflow checks out full history before diffing." >&2
    exit 1
  fi
done

changed="$(git diff --name-only "$base_sha" "$head_sha")"
manifest_pattern='(^|/)package\.json$|^pnpm-workspace\.yaml$|^\.npmrc$|^pnpmfile\.(cjs|js|mjs)$'

if printf '%s\n' "$changed" | grep -Eq "$manifest_pattern"; then
  echo "Dependency manifests changed; refreshing pnpm-lock.yaml in the CI workspace."
  pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile
else
  echo "Dependency manifests unchanged; keeping the checked-in pnpm-lock.yaml."
fi

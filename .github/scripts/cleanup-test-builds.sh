#!/usr/bin/env bash
# Deletes draft releases left by the Windows test build: every "Build log"
# draft and every "Windows test build" draft except the newest one per
# architecture. Published releases are never touched.
set -euo pipefail

repo="${GITHUB_REPOSITORY:?}"
gh api --paginate "repos/$repo/releases" \
  --jq '.[] | select(.draft) | {id, name, created_at}' \
  | jq -r -s '
      def arch: (.name | capture("\\((?<a>[^)]+)\\)")? | .a) // "x86_64-pc-windows-msvc";
      (map(select(.name | startswith("Windows test build")))
        | group_by(arch) | map(max_by(.created_at).id)) as $keep
      | .[]
      | select((.name | startswith("Windows test build")) or (.name | startswith("Build log")))
      | select(.id as $id | $keep | index($id) | not)
      | "\(.id)\t\(.name)"' \
  | while IFS=$'\t' read -r id name; do
      echo "Deleting draft: $name"
      gh api -X DELETE "repos/$repo/releases/$id"
    done

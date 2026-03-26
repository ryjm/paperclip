#!/usr/bin/env bash
set -euo pipefail

base_cwd="${PAPERCLIP_WORKSPACE_BASE_CWD:?PAPERCLIP_WORKSPACE_BASE_CWD is required}"
worktree_cwd="${PAPERCLIP_WORKSPACE_CWD:?PAPERCLIP_WORKSPACE_CWD is required}"
paperclip_home="${PAPERCLIP_HOME:-$HOME/.paperclip}"
paperclip_instance_id="${PAPERCLIP_INSTANCE_ID:-default}"
paperclip_dir="$worktree_cwd/.paperclip"
worktree_config_path="$paperclip_dir/config.json"
worktree_env_path="$paperclip_dir/.env"
worktree_name="${PAPERCLIP_WORKSPACE_BRANCH:-$(basename "$worktree_cwd")}"

if [[ ! -d "$base_cwd" ]]; then
  echo "Base workspace does not exist: $base_cwd" >&2
  exit 1
fi

if [[ ! -d "$worktree_cwd" ]]; then
  echo "Derived worktree does not exist: $worktree_cwd" >&2
  exit 1
fi

source_config_path="${PAPERCLIP_CONFIG:-}"
if [[ -z "$source_config_path" && ( -e "$base_cwd/.paperclip/config.json" || -L "$base_cwd/.paperclip/config.json" ) ]]; then
  source_config_path="$base_cwd/.paperclip/config.json"
fi
if [[ -z "$source_config_path" ]]; then
  source_config_path="$paperclip_home/instances/$paperclip_instance_id/config.json"
fi
source_env_path="$(dirname "$source_config_path")/.env"

mkdir -p "$paperclip_dir"

if [[ ! -e "$worktree_config_path" && ! -L "$worktree_config_path" && -e "$source_config_path" ]]; then
  ln -s "$source_config_path" "$worktree_config_path"
fi

if [[ ! -e "$worktree_env_path" && -e "$source_env_path" ]]; then
  cp "$source_env_path" "$worktree_env_path"
  chmod 600 "$worktree_env_path"
fi

tmp_env="$(mktemp "${TMPDIR:-/tmp}/paperclip-worktree-env.XXXXXX")"
if [[ -e "$worktree_env_path" ]]; then
  grep -vE '^(PAPERCLIP_IN_WORKTREE|PAPERCLIP_WORKTREE_NAME)=' "$worktree_env_path" > "$tmp_env" || true
fi
{
  printf 'PAPERCLIP_IN_WORKTREE=true\n'
  printf 'PAPERCLIP_WORKTREE_NAME=%s\n' "$worktree_name"
} >> "$tmp_env"
mv "$tmp_env" "$worktree_env_path"
chmod 600 "$worktree_env_path"

while IFS= read -r relative_path; do
  [[ -n "$relative_path" ]] || continue
  source_path="$base_cwd/$relative_path"
  target_path="$worktree_cwd/$relative_path"

  [[ -d "$source_path" ]] || continue
  [[ -e "$target_path" || -L "$target_path" ]] && continue

  mkdir -p "$(dirname "$target_path")"
  ln -s "$source_path" "$target_path"
done < <(
  cd "$base_cwd" &&
    find . \
      -mindepth 1 \
      -maxdepth 3 \
      -type d \
      -name node_modules \
      ! -path './.git/*' \
      ! -path './.paperclip/*' \
      | sed 's#^\./##'
)

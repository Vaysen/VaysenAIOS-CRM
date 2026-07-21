#!/usr/bin/env sh
# Install a verified runtime snapshot into an empty protected bind-mount root.
# The caller validates the archive with restore-runtime-data.sh --check first.

set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$script_dir/runtime-link-manifest.sh"
[ -f "$script_dir/runtime-link-contract.mjs" ] && [ ! -L "$script_dir/runtime-link-contract.mjs" ] \
  || { echo 'runtime link contract helper is missing or unsafe' >&2; exit 1; }
[ -f "$script_dir/run-runtime-link-contract.sh" ] && [ ! -L "$script_dir/run-runtime-link-contract.sh" ] \
  || { echo 'runtime link contract runner is missing or unsafe' >&2; exit 1; }

target="${1:-}"
archive="${2:-}"
app_uid="${3:-}"
app_gid="${4:-}"
has_openclaw="${5:-0}"
openclaw_uid="${6:-1000}"
openclaw_gid="${7:-1000}"

case "$target" in /*) ;; *) echo 'initialize target must be absolute' >&2; exit 1 ;; esac
[ "$target" != / ] || { echo 'initialize target must not be root' >&2; exit 1; }
[ -d "$target" ] && [ ! -L "$target" ] || { echo 'initialize target is unsafe' >&2; exit 1; }
[ -f "$archive" ] && [ ! -L "$archive" ] || { echo 'initialize archive is unsafe' >&2; exit 1; }
for numeric_id in "$app_uid" "$app_gid" "$openclaw_uid" "$openclaw_gid"; do
  case "$numeric_id" in ''|*[!0-9]*) echo 'initialize uid/gid values must be numeric' >&2; exit 1 ;; esac
done
[ "$has_openclaw" = 0 ] || [ "$has_openclaw" = 1 ] \
  || { echo 'has_openclaw must be 0 or 1' >&2; exit 1; }

txn="$target/.prepare-new"
state_name='.initialize-state-v1'
base_dirs='uploads .customizer-assets .whatsapp-sessions'
dirs="$base_dirs"
if [ "$has_openclaw" = 1 ]; then dirs="$dirs openclaw"; fi

path_exists() { [ -e "$1" ] || [ -L "$1" ]; }

validate_initialized_tree() {
  expected_openclaw="$1"
  [ -f "$target/.initialized-v1" ] && [ ! -L "$target/.initialized-v1" ] || return 1
  for d in $base_dirs; do
    [ -d "$target/$d" ] && [ ! -L "$target/$d" ] || return 1
  done
  ! find "$target/uploads" "$target/.customizer-assets" \
    "$target/.whatsapp-sessions" ! -type d ! -type f -print -quit | grep -q . || return 1
  if [ "$expected_openclaw" = 1 ]; then
    [ -d "$target/openclaw" ] && [ ! -L "$target/openclaw" ] || return 1
    bash "$script_dir/run-runtime-link-contract.sh" verify-tree "$target/openclaw" \
      >/dev/null || return 1
    ! find "$target/openclaw" ! -type d ! -type f ! -type l -print -quit | grep -q . || return 1
  else
    ! path_exists "$target/openclaw" || return 1
    [ "$(find "$target/uploads" "$target/.customizer-assets" \
      "$target/.whatsapp-sessions" -type l | wc -l | tr -d ' ')" -eq 0 ] || return 1
  fi
  ! path_exists "$target/$RUNTIME_LINK_MANIFEST_V1" || return 1
  ! path_exists "$target/$RUNTIME_LINK_MANIFEST_V2" || return 1
}

cleanup_committed_initialize() {
  [ -f "$txn/committed" ] && [ ! -L "$txn/committed" ] || return 1
  # Keep the durable decision until every other transaction byte is gone.
  # A kill during cleanup therefore remains cleanup-only on the next run.
  rm -f "$txn/$state_name"
  unexpected_cleanup="$(find "$txn" -mindepth 1 -maxdepth 1 ! -name committed -print -quit)"
  [ -z "$unexpected_cleanup" ] \
    || { echo 'committed initialize transaction contains unexpected cleanup state' >&2; return 1; }
  rm -f "$txn/committed"
  rmdir "$txn"
}

[ ! -L "$txn" ] || { echo 'initialize transaction path is a symlink' >&2; exit 1; }

# Recover a process/power interruption without relying on an in-memory trap.
# A durable committed sentinel means the initialized tree won and txn is only
# stale cleanup. Without it, the original target was empty, so remove exactly
# the fixed runtime paths and retry the installation from the verified archive.
if path_exists "$txn"; then
  [ -d "$txn" ] && [ ! -L "$txn" ] \
    || { echo 'initialize transaction path is unsafe' >&2; exit 1; }
  if path_exists "$txn/committed"; then
    [ -f "$txn/committed" ] && [ ! -L "$txn/committed" ] \
      || { echo 'initialize committed sentinel is unsafe' >&2; exit 1; }
    previous_openclaw="$(cat "$txn/committed")"
    [ "$previous_openclaw" = 0 ] || [ "$previous_openclaw" = 1 ] \
      || { echo 'initialize committed sentinel is invalid' >&2; exit 1; }
    if path_exists "$txn/$state_name"; then
      [ -f "$txn/$state_name" ] && [ ! -L "$txn/$state_name" ] \
        || { echo 'initialize transaction state is unsafe' >&2; exit 1; }
      [ "$(cat "$txn/$state_name")" = "$previous_openclaw" ] \
        || { echo 'initialize committed sentinel disagrees with transaction state' >&2; exit 1; }
    fi
    validate_initialized_tree "$previous_openclaw" \
      || { echo 'committed initialized tree is incomplete' >&2; exit 1; }
    cleanup_committed_initialize
    exit 0
  fi
  if ! path_exists "$txn/$state_name"; then
    outside_txn="$(find "$target" -mindepth 1 -maxdepth 1 ! -name '.prepare-new' -print -quit)"
    inside_txn="$(find "$txn" -mindepth 1 -print -quit)"
    if [ -z "$outside_txn" ] && [ -z "$inside_txn" ]; then
      rmdir "$txn"
    elif [ -z "$inside_txn" ] && path_exists "$target/.initialized-v1"; then
      inferred_openclaw=0
      if path_exists "$target/openclaw"; then inferred_openclaw=1; fi
      validate_initialized_tree "$inferred_openclaw" \
        || { echo 'initialize cleanup boundary has an invalid committed tree' >&2; exit 1; }
      rmdir "$txn"
      exit 0
    else
      echo 'initialize transaction state is missing; manual inspection required' >&2
      exit 1
    fi
  else
    [ -f "$txn/$state_name" ] && [ ! -L "$txn/$state_name" ] \
      || { echo 'initialize transaction state is unsafe' >&2; exit 1; }
    previous_openclaw="$(cat "$txn/$state_name")"
    [ "$previous_openclaw" = 0 ] || [ "$previous_openclaw" = 1 ] \
      || { echo 'initialize transaction state is invalid' >&2; exit 1; }
  fi
  for d in $base_dirs openclaw; do
    if path_exists "$target/$d"; then rm -rf "$target/$d"; fi
  done
  rm -f "$target/.initialized-v1" "$target/.initialized-v1.tmp"
  rm -rf "$txn"
fi

unexpected_target="$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)"
[ -z "$unexpected_target" ] || { echo 'initialize target is not empty' >&2; exit 1; }
mkdir -p "$txn"
printf '%s\n' "$has_openclaw" > "$txn/$state_name"
chmod 600 "$txn/$state_name"

rollback_initialize() {
  if path_exists "$txn/committed"; then
    if [ -f "$txn/committed" ] && [ ! -L "$txn/committed" ]; then
      cleanup_committed_initialize
      return
    fi
    echo 'initialize committed sentinel became unsafe; preserving transaction for inspection' >&2
    return
  else
    for d in $base_dirs openclaw; do rm -rf "$target/$d"; done
    rm -f "$target/.initialized-v1" "$target/.initialized-v1.tmp"
  fi
  rm -rf "$txn"
}
trap rollback_initialize EXIT HUP INT TERM

tar -xzf "$archive" -C "$txn"
unexpected_archive="$(find "$txn" -mindepth 1 -maxdepth 1 \
  ! -name uploads ! -name .customizer-assets ! -name .whatsapp-sessions \
  ! -name openclaw ! -name "$RUNTIME_LINK_MANIFEST_V1" ! -name "$RUNTIME_LINK_MANIFEST_V2" \
  ! -name "$state_name" -print -quit)"
[ -z "$unexpected_archive" ] || { echo 'initialize archive has an unexpected top-level entry' >&2; exit 1; }

for d in $dirs; do
  [ -d "$txn/$d" ] && [ ! -L "$txn/$d" ]
  [ ! -e "$target/$d" ] && [ ! -L "$target/$d" ]
done
if find "$txn" ! -type d ! -type f -print -quit | grep -q .; then
  echo 'initialize archive contains a raw link or special file' >&2
  exit 1
fi

link_manifest=''
link_paths="$txn/.validated-runtime-link-paths"
link_manifest_count=0
for manifest_name in "$RUNTIME_LINK_MANIFEST_V1" "$RUNTIME_LINK_MANIFEST_V2"; do
  candidate_manifest="$txn/$manifest_name"
  if [ -e "$candidate_manifest" ] || [ -L "$candidate_manifest" ]; then
    [ -f "$candidate_manifest" ] && [ ! -L "$candidate_manifest" ] \
      || { echo 'initialize peer-link manifest is unsafe' >&2; exit 1; }
    link_manifest_count=$((link_manifest_count + 1))
    link_manifest="$candidate_manifest"
  fi
done
[ "$link_manifest_count" -le 1 ] \
  || { echo 'initialize archive contains multiple peer-link manifests' >&2; exit 1; }
if [ "$link_manifest_count" -eq 1 ]; then
  bash "$script_dir/run-runtime-link-contract.sh" verify-manifest \
    "$txn/openclaw" "$link_manifest" > "$link_paths" \
    || { echo 'initialize peer-link manifest is invalid or disagrees with SQLite' >&2; exit 1; }
fi
[ "$has_openclaw:$link_manifest_count" = '0:0' ] \
  || [ "$has_openclaw:$link_manifest_count" = '1:1' ] \
  || { echo 'initialize OpenClaw state and peer-link manifest disagree' >&2; exit 1; }

for d in $base_dirs; do
  chown -R "$app_uid:$app_gid" "$txn/$d"
  chmod 700 "$txn/$d"
done
if [ "$has_openclaw" = 1 ]; then
  chown -R "$openclaw_uid:$openclaw_gid" "$txn/openclaw"
  chmod 700 "$txn/openclaw"
fi

if [ "$link_manifest_count" -eq 1 ]; then
  while IFS= read -r relative || [ -n "$relative" ]; do
    runtime_link_path_kind "$relative" >/dev/null \
      || { echo 'initialize peer-link path failed final validation' >&2; exit 1; }
    link="$txn/$relative"
    parent="${link%/*}"
    [ -d "$parent" ] && [ ! -L "$parent" ] \
      || { echo 'initialize peer-link parent is unsafe' >&2; exit 1; }
    [ ! -e "$link" ] && [ ! -L "$link" ] \
      || { echo 'initialize peer-link destination already exists' >&2; exit 1; }
    ln -s /app "$link"
    chown -h "$openclaw_uid:$openclaw_gid" "$link"
  done < "$link_paths"
fi

for d in $dirs; do mv "$txn/$d" "$target/$d"; done
if [ -n "$link_manifest" ]; then rm -f "$link_manifest"; fi
rm -f "$link_paths"
[ -z "$(find "$txn" -mindepth 1 ! -name "$state_name" -print -quit)" ] \
  || { echo 'initialize transaction contains unconsumed state' >&2; exit 1; }
printf 'initialized from verified runtime backup\n' > "$target/.initialized-v1.tmp"
chmod 600 "$target/.initialized-v1.tmp"
mv "$target/.initialized-v1.tmp" "$target/.initialized-v1"
validate_initialized_tree "$has_openclaw" \
  || { echo 'initialized runtime tree failed final validation' >&2; exit 1; }
committed_tmp="$txn/committed.tmp"
printf '%s\n' "$has_openclaw" > "$committed_tmp"
chmod 600 "$committed_tmp"
mv "$committed_tmp" "$txn/committed"
trap - EXIT HUP INT TERM
cleanup_committed_initialize

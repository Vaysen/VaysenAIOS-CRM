#!/usr/bin/env sh
# Atomic runtime-directory replacement. Production runs this inside the
# digest-pinned helper image; contract tests run the same file on a temp tree.

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

case "$target" in /*) ;; *) echo 'restore target must be absolute' >&2; exit 1 ;; esac
[ "$target" != / ] || { echo 'restore target must not be root' >&2; exit 1; }
[ -d "$target" ] && [ ! -L "$target" ] || { echo 'restore target is unsafe' >&2; exit 1; }
[ -f "$archive" ] && [ ! -L "$archive" ] || { echo 'restore archive is unsafe' >&2; exit 1; }
for numeric_id in "$app_uid" "$app_gid" "$openclaw_uid" "$openclaw_gid"; do
  case "$numeric_id" in ''|*[!0-9]*) echo 'restore uid/gid values must be numeric' >&2; exit 1 ;; esac
done
[ "$has_openclaw" = 0 ] || [ "$has_openclaw" = 1 ] \
  || { echo 'has_openclaw must be 0 or 1' >&2; exit 1; }

txn="$target/.restore-transaction"
txn_preparing="$target/.restore-transaction.preparing"
base_dirs='uploads .customizer-assets .whatsapp-sessions'
dirs="$base_dirs"
if [ "$has_openclaw" = 1 ]; then dirs="$dirs openclaw"; fi
recover_dirs="$base_dirs openclaw"
[ ! -L "$txn" ] || { echo 'restore transaction path is a symlink' >&2; exit 1; }
[ ! -L "$txn_preparing" ] || { echo 'restore transaction preparation path is a symlink' >&2; exit 1; }

path_exists() { [ -e "$1" ] || [ -L "$1" ]; }

validate_committed_tree() {
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

validate_original_dirs() {
  [ -f "$txn/original-dirs" ] && [ ! -L "$txn/original-dirs" ] || return 1
  unexpected="$(grep -Ev '^(uploads|\.customizer-assets|\.whatsapp-sessions|openclaw)$' \
    "$txn/original-dirs" || true)"
  [ -z "$unexpected" ] || return 1
  [ "$(sort "$txn/original-dirs" | uniq | wc -l | tr -d ' ')" = \
    "$(wc -l < "$txn/original-dirs" | tr -d ' ')" ] || return 1
  for required in $base_dirs; do
    grep -Fxq "$required" "$txn/original-dirs" || return 1
  done
}

original_had_dir() {
  grep -Fxq "$1" "$txn/original-dirs"
}

restore_old_tree() {
  [ -f "$txn/marker" ] && [ ! -L "$txn/marker" ] \
    || { echo 'restore transaction is missing its protected old marker' >&2; return 1; }

  if [ -e "$txn/original-dirs" ] || [ -L "$txn/original-dirs" ]; then
    validate_original_dirs \
      || { echo 'restore transaction original-directory manifest is unsafe' >&2; return 1; }
    for d in $recover_dirs; do
      if original_had_dir "$d"; then
        if path_exists "$txn/old/$d"; then
          [ -d "$txn/old/$d" ] && [ ! -L "$txn/old/$d" ] \
            || { echo "restore transaction old directory is unsafe: $d" >&2; return 1; }
        else
          # A failure before this directory was moved leaves the original in
          # place. It is safe only while that path is still a real directory.
          [ -d "$target/$d" ] && [ ! -L "$target/$d" ] \
            || { echo "restore transaction lost both copies of old directory: $d" >&2; return 1; }
        fi
      elif path_exists "$txn/old/$d"; then
        echo "restore transaction contains an unrecorded old directory: $d" >&2
        return 1
      fi
    done
    for d in $recover_dirs; do
      if original_had_dir "$d"; then
        if path_exists "$txn/old/$d"; then
          if path_exists "$target/$d"; then rm -rf "$target/$d"; fi
          mv "$txn/old/$d" "$target/$d"
        fi
      elif path_exists "$target/$d"; then
        rm -rf "$target/$d"
      fi
    done
  else
    # An older transaction did not record originally absent directories. Only
    # recover paths that are definitely in txn/old. If a target path exists
    # without its old counterpart, it could be either old or candidate data;
    # guessing would risk preserving or deleting protected customer state.
    for d in $recover_dirs; do
      if path_exists "$txn/old/$d"; then
        [ -d "$txn/old/$d" ] && [ ! -L "$txn/old/$d" ] \
          || { echo "legacy restore transaction old path is unsafe: $d" >&2; return 1; }
      elif path_exists "$target/$d"; then
        echo "legacy restore transaction is ambiguous for $d; manual inspection required" >&2
        return 1
      else
        case "$d" in
          openclaw) ;;
          *) echo "legacy restore transaction lost required old directory: $d" >&2; return 1 ;;
        esac
      fi
    done
    # Validation is intentionally complete before the first mutation so a
    # late ambiguity preserves every byte required for manual recovery.
    for d in $recover_dirs; do
      if path_exists "$txn/old/$d"; then
        if path_exists "$target/$d"; then rm -rf "$target/$d"; fi
        mv "$txn/old/$d" "$target/$d"
      fi
    done
  fi

  marker_tmp="$target/.initialized-v1.restore-tmp"
  rm -f "$marker_tmp"
  cp "$txn/marker" "$marker_tmp"
  chmod 600 "$marker_tmp"
  mv "$marker_tmp" "$target/.initialized-v1"
}

cleanup_committed_transaction() {
  [ -f "$txn/committed" ] && [ ! -L "$txn/committed" ] || return 1
  # Delete protected old data before deleting the durable commit decision.
  # If cleanup is killed, re-entry still sees committed and never rolls back.
  rm -rf "$txn/new" "$txn/old"
  rm -f "$txn/marker" "$txn/original-dirs" "$txn/original-dirs.tmp" \
    "$txn/new-marker" "$txn/committed.tmp" "$txn/$RUNTIME_LINK_MANIFEST_V1" \
    "$txn/$RUNTIME_LINK_MANIFEST_V2" "$txn/.validated-runtime-link-paths"
  unexpected_cleanup="$(find "$txn" -mindepth 1 -maxdepth 1 ! -name committed -print -quit)"
  [ -z "$unexpected_cleanup" ] \
    || { echo 'committed restore transaction contains unexpected cleanup state' >&2; return 1; }
  rm -f "$txn/committed"
  rmdir "$txn"
}

# A regular committed sentinel is the durable decision record. Once present,
# the new tree must never be replaced with txn/old; only stale transaction
# files may be removed. Without it, restore the exact recorded old tree.
if [ -e "$txn" ] || [ -L "$txn" ]; then
  [ -d "$txn" ] && [ ! -L "$txn" ] \
    || { echo 'restore transaction path is unsafe' >&2; exit 1; }
  if [ -e "$txn/committed" ] || [ -L "$txn/committed" ]; then
    [ -f "$txn/committed" ] && [ ! -L "$txn/committed" ] \
      || { echo 'restore committed sentinel is unsafe' >&2; exit 1; }
    previous_openclaw="$(cat "$txn/committed")"
    [ "$previous_openclaw" = 0 ] || [ "$previous_openclaw" = 1 ] \
      || { echo 'restore committed sentinel is invalid' >&2; exit 1; }
    validate_committed_tree "$previous_openclaw" \
      || { echo 'committed runtime tree is incomplete; refusing reverse rollback' >&2; exit 1; }
    cleanup_committed_transaction
  elif [ -z "$(find "$txn" -mindepth 1 -print -quit)" ]; then
    # The committed sentinel is deliberately removed last. An empty leftover
    # directory can therefore only be the final post-commit cleanup boundary.
    rmdir "$txn"
  else
    restore_old_tree
    rm -rf "$txn"
  fi
fi

# Metadata is built under a separate preparation directory and published with
# one atomic rename. A SIGKILL before that rename cannot create an ambiguous
# restore transaction; on re-entry every protected business directory is
# still in place, so the unpublished preparation tree is safe to discard.
if [ -e "$txn_preparing" ] || [ -L "$txn_preparing" ]; then
  [ ! -e "$txn" ] && [ ! -L "$txn" ] \
    || { echo 'restore transaction and preparation state coexist' >&2; exit 1; }
  [ -d "$txn_preparing" ] && [ ! -L "$txn_preparing" ] \
    || { echo 'restore transaction preparation path is unsafe' >&2; exit 1; }
  for d in $base_dirs; do
    [ -d "$target/$d" ] && [ ! -L "$target/$d" ] \
      || { echo 'cannot discard interrupted preparation after a business directory moved' >&2; exit 1; }
  done
  rm -rf "$txn_preparing"
fi

[ -f "$target/.initialized-v1" ] && [ ! -L "$target/.initialized-v1" ] \
  || { echo 'restore target marker is missing or unsafe' >&2; exit 1; }
for d in $base_dirs; do
  [ -d "$target/$d" ] && [ ! -L "$target/$d" ] \
    || { echo "restore target is missing a required original directory: $d" >&2; exit 1; }
done
mkdir "$txn_preparing"
mkdir "$txn_preparing/new" "$txn_preparing/old"
cp "$target/.initialized-v1" "$txn_preparing/marker"
original_tmp="$txn_preparing/original-dirs.tmp"
: > "$original_tmp"
for d in $recover_dirs; do
  if path_exists "$target/$d"; then
    [ -d "$target/$d" ] && [ ! -L "$target/$d" ] \
      || { echo "restore target directory is unsafe: $d" >&2; exit 1; }
    printf '%s\n' "$d" >> "$original_tmp"
  fi
done
chmod 600 "$original_tmp"
mv "$original_tmp" "$txn_preparing/original-dirs"
mv "$txn_preparing" "$txn"
validate_original_dirs \
  || { echo 'fresh restore transaction original-directory manifest is incomplete' >&2; exit 1; }

rollback_transaction() {
  if [ -e "$txn/committed" ] || [ -L "$txn/committed" ]; then
    if [ -f "$txn/committed" ] && [ ! -L "$txn/committed" ]; then
      cleanup_committed_transaction
      return
    fi
    echo 'restore committed sentinel became unsafe; preserving transaction for inspection' >&2
    return
  fi
  restore_old_tree
  rm -rf "$txn"
}
trap rollback_transaction EXIT HUP INT TERM

tar -xzf "$archive" -C "$txn/new"
for d in $dirs; do
  [ -d "$txn/new/$d" ] && [ ! -L "$txn/new/$d" ]
  if find "$txn/new/$d" ! -type d ! -type f -print -quit | grep -q .; then
    echo "runtime archive contains a raw link or special file: $d" >&2
    exit 1
  fi
done

link_manifest=''
link_paths="$txn/.validated-runtime-link-paths"
link_manifest_count=0
for manifest_name in "$RUNTIME_LINK_MANIFEST_V1" "$RUNTIME_LINK_MANIFEST_V2"; do
  candidate_manifest="$txn/new/$manifest_name"
  if [ -e "$candidate_manifest" ] || [ -L "$candidate_manifest" ]; then
    [ -f "$candidate_manifest" ] && [ ! -L "$candidate_manifest" ] \
      || { echo 'runtime peer-link manifest is unsafe' >&2; exit 1; }
    link_manifest_count=$((link_manifest_count + 1))
    link_manifest="$txn/$manifest_name"
    mv "$candidate_manifest" "$link_manifest"
  fi
done
[ "$link_manifest_count" -le 1 ] \
  || { echo 'runtime archive contains multiple peer-link manifests' >&2; exit 1; }
[ "$has_openclaw:$link_manifest_count" = '0:0' ] \
  || [ "$has_openclaw:$link_manifest_count" = '1:1' ] \
  || { echo 'runtime OpenClaw state and peer-link manifest disagree' >&2; exit 1; }
if [ "$link_manifest_count" -eq 1 ]; then
  bash "$script_dir/run-runtime-link-contract.sh" verify-manifest \
    "$txn/new/openclaw" "$link_manifest" > "$link_paths" \
    || { echo 'runtime peer-link manifest is invalid or disagrees with SQLite' >&2; exit 1; }
fi
for d in $recover_dirs; do
  if path_exists "$target/$d"; then [ -d "$target/$d" ] && [ ! -L "$target/$d" ]; fi
done
for d in $base_dirs; do
  chown -R "$app_uid:$app_gid" "$txn/new/$d"
  chmod 700 "$txn/new/$d"
done
if [ "$has_openclaw" = 1 ]; then
  chown -R "$openclaw_uid:$openclaw_gid" "$txn/new/openclaw"
  chmod 700 "$txn/new/openclaw"
fi

if [ "$link_manifest_count" -eq 1 ]; then
  [ "$has_openclaw" = 1 ] || { echo 'legacy runtime archive must not contain OpenClaw peer links' >&2; exit 1; }
  while IFS= read -r relative || [ -n "$relative" ]; do
    runtime_link_path_kind "$relative" >/dev/null \
      || { echo 'runtime peer-link path failed final validation' >&2; exit 1; }
    link="$txn/new/$relative"
    parent="${link%/*}"
    [ -d "$parent" ] && [ ! -L "$parent" ] \
      || { echo 'runtime peer-link parent is unsafe' >&2; exit 1; }
    [ ! -e "$link" ] && [ ! -L "$link" ] \
      || { echo 'runtime peer-link destination already exists' >&2; exit 1; }
    ln -s /app "$link"
    chown -h "$openclaw_uid:$openclaw_gid" "$link"
  done < "$link_paths"
fi

# Always move the candidate OpenClaw tree aside. A verified legacy snapshot
# has no openclaw directory, therefore a successful legacy rollback removes
# candidate-created state; the trap restores it if a later move fails.
for d in $recover_dirs; do
  if path_exists "$target/$d"; then mv "$target/$d" "$txn/old/$d"; fi
done
for d in $dirs; do mv "$txn/new/$d" "$target/$d"; done
marker_tmp="$txn/new-marker"
printf 'restored from verified runtime backup\n' > "$marker_tmp"
chmod 600 "$marker_tmp"
mv "$marker_tmp" "$target/.initialized-v1"
validate_committed_tree "$has_openclaw" \
  || { echo 'restored runtime tree failed final validation' >&2; exit 1; }
committed_tmp="$txn/committed.tmp"
printf '%s\n' "$has_openclaw" > "$committed_tmp"
chmod 600 "$committed_tmp"
mv "$committed_tmp" "$txn/committed"
trap - EXIT HUP INT TERM
cleanup_committed_transaction

#!/usr/bin/env sh
# Shared, fail-closed path grammar for the two derived OpenClaw peer links that
# cannot be stored as raw tar symlinks. OpenClaw may promote an active managed
# install from its stable project root into a generation root. Generation names
# are syntax-checked here; the SQLite install index remains the trust root and is
# checked by runtime-link-contract.mjs before a link is encoded or recreated.

RUNTIME_LINK_MANIFEST_V1='.vaysen-crm-runtime-links-v1'
RUNTIME_LINK_MANIFEST_V2='.vaysen-crm-runtime-links-v2.json'
RUNTIME_LINK_MANIFEST="$RUNTIME_LINK_MANIFEST_V2"
RUNTIME_WEIXIN_PROJECT_ROOT='openclaw/npm/projects/tencent-weixin-openclaw-weixin-7783ac86ba'
RUNTIME_CRM_PROJECT_ROOT='openclaw/npm/projects/vaysen-openclaw-crm-tools-f0ac731cd3'
RUNTIME_WEIXIN_PEER_SUFFIX='/node_modules/@tencent-weixin/openclaw-weixin/node_modules/openclaw'
RUNTIME_CRM_PEER_SUFFIX='/node_modules/@vaysen/openclaw-crm-tools/node_modules/openclaw'
RUNTIME_WEIXIN_PEER_LINK='openclaw/npm/projects/tencent-weixin-openclaw-weixin-7783ac86ba/node_modules/@tencent-weixin/openclaw-weixin/node_modules/openclaw'
RUNTIME_CRM_PEER_LINK='openclaw/npm/projects/vaysen-openclaw-crm-tools-f0ac731cd3/node_modules/@vaysen/openclaw-crm-tools/node_modules/openclaw'

runtime_link_generation_id() {
    runtime_link_candidate="$1"
    runtime_link_root="$2"
    runtime_link_suffix="$3"
    runtime_link_prefix="${runtime_link_root}__openclaw-generation__g-"
    case "$runtime_link_candidate" in
        "$runtime_link_prefix"*"$runtime_link_suffix") ;;
        *) return 1 ;;
    esac
    runtime_link_generation_tail="${runtime_link_candidate#"$runtime_link_prefix"}"
    runtime_link_generation_id="${runtime_link_generation_tail%%/*}"
    [ "${#runtime_link_generation_id}" -eq 16 ] || return 1
    case "$runtime_link_generation_id" in *[!0-9a-f]*) return 1 ;; esac
    [ "$runtime_link_candidate" = "${runtime_link_prefix}${runtime_link_generation_id}${runtime_link_suffix}" ] \
        || return 1
    printf '%s' "$runtime_link_generation_id"
}

runtime_link_path_kind() {
    runtime_link_path="$1"
    case "$runtime_link_path" in
        "$RUNTIME_WEIXIN_PEER_LINK") printf '%s' weixin ;;
        "$RUNTIME_CRM_PEER_LINK") printf '%s' crm ;;
        *)
            if runtime_link_generation_id "$runtime_link_path" \
                "$RUNTIME_WEIXIN_PROJECT_ROOT" "$RUNTIME_WEIXIN_PEER_SUFFIX" >/dev/null; then
                printf '%s' weixin
            elif runtime_link_generation_id "$runtime_link_path" \
                "$RUNTIME_CRM_PROJECT_ROOT" "$RUNTIME_CRM_PEER_SUFFIX" >/dev/null; then
                printf '%s' crm
            else
                return 1
            fi
            ;;
    esac
}

runtime_link_manifest_validate_file() {
    runtime_link_manifest_file="$1"
    [ -f "$runtime_link_manifest_file" ] && [ ! -L "$runtime_link_manifest_file" ] || return 1

    runtime_link_count=0
    runtime_link_weixin=0
    runtime_link_crm=0
    while IFS= read -r runtime_link_relative || [ -n "$runtime_link_relative" ]; do
        [ -n "$runtime_link_relative" ] || return 1
        case "$runtime_link_relative" in /*|*'..'*) return 1 ;; esac
        runtime_link_kind="$(runtime_link_path_kind "$runtime_link_relative")" || return 1
        case "$runtime_link_kind" in
            weixin)
                runtime_link_weixin=$((runtime_link_weixin + 1))
                [ "$runtime_link_weixin" -eq 1 ] || return 1
                ;;
            crm)
                runtime_link_crm=$((runtime_link_crm + 1))
                [ "$runtime_link_crm" -eq 1 ] || return 1
                ;;
            *) return 1 ;;
        esac
        runtime_link_count=$((runtime_link_count + 1))
    done < "$runtime_link_manifest_file"

    [ "$runtime_link_count" -eq 2 ] \
        && [ "$runtime_link_weixin" -eq 1 ] \
        && [ "$runtime_link_crm" -eq 1 ]
}

runtime_link_manifest_name_is_supported() {
    [ "$1" = "$RUNTIME_LINK_MANIFEST_V1" ] || [ "$1" = "$RUNTIME_LINK_MANIFEST_V2" ]
}

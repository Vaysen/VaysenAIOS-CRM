#!/bin/sh
set -eu

SETTINGS_PATH="${SEARXNG_SETTINGS_PATH:-/etc/searxng/settings.yml}"
TEMPLATE_PATH="${SEARXNG_TEMPLATE_PATH:-/usr/local/searxng/settings.template.yml}"
UPSTREAM_ENTRYPOINT="${SEARXNG_UPSTREAM_ENTRYPOINT:-/usr/local/searxng/entrypoint.sh}"

mkdir -p "$(dirname "$SETTINGS_PATH")"

if [ ! -f "$SETTINGS_PATH" ]; then
  if [ ! -f "$TEMPLATE_PATH" ]; then
    echo "SearXNG settings template not found: $TEMPLATE_PATH" >&2
    exit 1
  fi

  cp "$TEMPLATE_PATH" "$SETTINGS_PATH"
  generated_secret="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-32)"
  if [ -z "$generated_secret" ]; then
    echo "Failed to generate SearXNG secret" >&2
    exit 1
  fi
  sed -i "s/ultrasecretkey/$generated_secret/g" "$SETTINGS_PATH"
fi

ENGINE_POLICY_MARKER='# Vaysen AI CRM China-network evidence engines v1'
if ! grep -Fqx "$ENGINE_POLICY_MARKER" "$SETTINGS_PATH"; then
  if grep -Eq '^engines:[[:space:]]*($|#)' "$SETTINGS_PATH" \
      || ! grep -Eq '^use_default_settings:[[:space:]]*true[[:space:]]*($|#)' "$SETTINGS_PATH"; then
    echo "SearXNG engine settings are ambiguous; refusing an unsafe rewrite" >&2
    exit 1
  fi

  next_settings="${SETTINGS_PATH}.next.$$"
  if ! awk -v marker="$ENGINE_POLICY_MARKER" '
    /^use_default_settings:[[:space:]]*true[[:space:]]*($|#)/ && !replaced {
      print marker
      print "use_default_settings:"
      print "  engines:"
      print "    keep_only:"
      print "      - baidu"
      print "      - bing"
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) exit 42 }
  ' "$SETTINGS_PATH" >"$next_settings"; then
    rm -f "$next_settings"
    echo "Failed to install the SearXNG evidence-engine policy" >&2
    exit 1
  fi
  cat >>"$next_settings" <<'EOF'

# The Linux host is deployed in mainland China. These two engines are directly
# reachable without consuming the operator's Windows VPN traffic.
engines:
  - name: baidu
    engine: baidu
    baidu_category: general
    categories: [general]
    shortcut: bd
    disabled: false
  - name: bing
    engine: bing
    categories: [general]
    shortcut: bi
    base_url: https://cn.bing.com
    disabled: false
EOF
  mv -f "$next_settings" "$SETTINGS_PATH"
fi

grep -Eq '^[[:space:]]*-[[:space:]]*baidu[[:space:]]*$' "$SETTINGS_PATH" \
  && grep -Eq '^[[:space:]]*-[[:space:]]*bing[[:space:]]*$' "$SETTINGS_PATH" \
  && grep -Fq 'base_url: https://cn.bing.com' "$SETTINGS_PATH" \
  || {
    echo "SearXNG evidence-engine policy is incomplete" >&2
    exit 1
  }

if ! grep -Eq '^[[:space:]]*-[[:space:]]*json([[:space:]#]|$)' "$SETTINGS_PATH"; then
  if grep -Eq '^search:[[:space:]]*($|#)' "$SETTINGS_PATH"; then
    echo "SearXNG search settings already exist without JSON; refusing an ambiguous rewrite" >&2
    exit 1
  fi

  cat >>"$SETTINGS_PATH" <<'EOF'

# Vaysen AI CRM workers consume the internal JSON API. The service remains bound
# to Docker networking and host loopback only; this does not publish it to LAN.
search:
  formats:
    - html
    - json
EOF
fi

chmod 600 "$SETTINGS_PATH"

if [ "${SEARXNG_CONFIGURE_ONLY:-false}" = "true" ]; then
  exit 0
fi

exec "$UPSTREAM_ENTRYPOINT" "$@"

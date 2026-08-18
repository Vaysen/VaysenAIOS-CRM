#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${PF_C_NPM_CLI:?PF_C_NPM_CLI must point to the reviewed npm 10.8.2 npm-cli.js}"

npm() {
  node "$PF_C_NPM_CLI" "$@"
}
export -f npm

[ "$(node -v)" = "v20.18.0" ] || {
  echo "private contracts require Node 20.18.0" >&2
  exit 1
}
[ "$(npm -v)" = "10.8.2" ] || {
  echo "private contracts require npm 10.8.2" >&2
  exit 1
}

printf '[private-contract-runtime] node=%s npm=%s\n' "$(node -v)" "$(npm -v)"
exec bash "$PROJECT_DIR/scripts/test-deploy-contracts.sh"

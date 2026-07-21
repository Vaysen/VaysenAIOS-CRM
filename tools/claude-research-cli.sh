#!/bin/bash
# Linux wrapper for Claude Code research CLI
# Usage: ./claude-research-cli.sh --company "Bollé" --website "bolle.com" --country "France"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/claude-research-cli.js" "$@"

#!/bin/bash
set -e

# Runs ob sync --continuous in the background alongside the main node app.
#
# Required env vars:
#   OBSIDIAN_AUTH_TOKEN   - Obsidian account token (run 'ob login' locally to get it,
#                           or use 'ob login --email ... --password ...' interactively)
#
# Optional env vars:
#   OBSIDIAN_VAULT_PATH   - Path to the pre-configured vault directory (default: /vault)
#                           The vault must have already been set up via 'ob sync-setup'.

VAULT_PATH="${OBSIDIAN_VAULT_PATH:-/vault}"

if [ -z "$OBSIDIAN_AUTH_TOKEN" ]; then
    echo "Warning: OBSIDIAN_AUTH_TOKEN is not set. ob sync may fail to authenticate." >&2
fi

if [ ! -d "$VAULT_PATH/config/obsidian-headless/sync" ]; then
    if [ -z "$OBSIDIAN_VAULT" ]; then
        echo "Warning: OBSIDIAN_VAULT is not set. Cannot configure." >&2
    else
        echo "Configuring Obsidian headless sync (vault: $VAULT_PATH)..."
        mkdir -p "$VAULT_PATH/data"
        pushd "$VAULT_PATH/data"
        XDG_CONFIG_HOME="$VAULT_PATH/config" ob sync-setup --vault "$OBSIDIAN_VAULT" --path "$VAULT_PATH/data" --device-name "svc.tyler.vc" --password "$OBSIDIAN_E2E"
        popd
    fi
fi

echo "Starting Obsidian headless sync (vault: $VAULT_PATH)..."
XDG_CONFIG_HOME="$VAULT_PATH/config" ob sync --continuous --path "$VAULT_PATH/data" &
OB_PID=$!

cleanup() {
    echo "Shutting down Obsidian sync..."
    if [ -n "$OB_PID" ] && kill -0 "$OB_PID" 2>/dev/null; then
        kill "$OB_PID" 2>/dev/null || true
        wait "$OB_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

# Run the main application in the foreground.
# When it exits (for any reason), the EXIT trap above will stop ob sync.
node dist/

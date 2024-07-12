#!/usr/bin/env sh

set -euo pipefail

HOME="$(mktemp -d)"
[ ! -d "$HOME" ] && exit 1

export HOME
exec "$@"

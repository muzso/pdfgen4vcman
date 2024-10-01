#!/usr/bin/env sh

set -euo pipefail

if echo "$@" | egrep -qias -- "--log-level[[:space:]]+debug"; then
  [ -f "/etc/alpine-release" ] && echo "Alpine version: $(cat "/etc/alpine-release")"
  echo "NodeJS version: $(node --version)"
fi

HOME="$(mktemp -d)"
[ ! -d "$HOME" ] && exit 1

export HOME
exec "$@"

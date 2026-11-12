#!/bin/sh
# Hosting platforms often mount the data disk owned by root. Fix ownership,
# then drop to the unprivileged "node" user to run the app.
set -e
DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"

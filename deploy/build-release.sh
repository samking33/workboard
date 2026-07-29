#!/usr/bin/env bash
# Builds a self-contained production binary (frontend embedded) plus the files
# needed to run it. Output lands in deploy/dist/.
#
#   ./deploy/build-release.sh              native build
#   TARGET=linux/amd64 ./deploy/build-release.sh   cross-compile for the server
#
# Hostinger VPS is almost always linux/amd64; build for that on a Mac, not
# native, or the binary will not execute on the server.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="$ROOT/deploy/dist"

GOOS_ARG=""
GOARCH_ARG=""
if [[ -n "${TARGET:-}" ]]; then
	GOOS_ARG="${TARGET%%/*}"
	GOARCH_ARG="${TARGET##*/}"
fi

echo "==> frontend"
pushd frontend >/dev/null

# package.json pins pnpm 11.13.1. Under corepack that pin is enforced exactly and
# pnpm refuses to self-switch, so a machine with any other 11.x fails with
# "This project is configured to use 11.13.1 of pnpm". The lockfile is what
# actually decides the dependency tree, and it is compatible across 11.x, so
# relax the strict match rather than forcing everyone onto one patch release.
export COREPACK_ENABLE_STRICT=0

# --frozen-lockfile is kept: the build must never silently resolve new versions.
pnpm install --frozen-lockfile
pnpm build
popd >/dev/null

echo "==> api"
rm -rf "$OUT"
mkdir -p "$OUT"

# CGO off keeps the binary static so it does not depend on the server's glibc.
# osusergo matches the tag the project's own mage build uses.
# Via `env` because an expanded VAR=value is a command word to bash, not an
# assignment, so writing it as a bare prefix fails with "GOOS=linux: not found".
env CGO_ENABLED=0 \
	${GOOS_ARG:+GOOS="$GOOS_ARG"} ${GOARCH_ARG:+GOARCH="$GOARCH_ARG"} \
	go build -tags osusergo -ldflags "-s -w" -o "$OUT/vikunja" .

cp deploy/config.prod.yml "$OUT/config.yml"
cp deploy/.env.example "$OUT/vikunja.env.example"
cp deploy/vikunja.service "$OUT/"
cp deploy/nginx.conf.example "$OUT/"
cp deploy/admin-panel.py "$OUT/"
cp deploy/sqlite-to-mysql.py "$OUT/"
cp deploy/README.md "$OUT/"

echo
echo "built $(du -h "$OUT/vikunja" | cut -f1) -> $OUT/vikunja"
file "$OUT/vikunja" 2>/dev/null || true
echo "upload the contents of $OUT to the server, then follow README.md"

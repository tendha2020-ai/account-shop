#!/bin/sh
# Vets the launcher for Linux and Windows and runs its Go tests (mock downloads,
# mock ComfyUI, proxy + WebSocket). Like build.sh, it copies glow/ next to the
# sources for go:embed and removes the copy afterwards.
set -e
cd "$(dirname "$0")"
rm -rf glow && cp -r ../glow ./glow
trap 'rm -rf glow' EXIT
go vet .
GOOS=windows GOARCH=amd64 go vet .
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .
go test -count=1 "$@" .

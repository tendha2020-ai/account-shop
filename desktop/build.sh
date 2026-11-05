#!/bin/sh
# Rebuilds downloads/GlowStudio.exe: bundles glow/ into a small Windows launcher
# that serves the app on 127.0.0.1 and opens it in an Edge/Chrome app window.
set -e
cd "$(dirname "$0")"
rm -rf glow && cp -r ../glow ./glow
# never leave the copy behind in the repo, even when the build fails
trap 'rm -rf glow' EXIT
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H windowsgui" -o ../downloads/GlowStudio.exe .
rm -rf glow

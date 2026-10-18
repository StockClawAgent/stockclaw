#!/usr/bin/env bash
# Build contract artifacts from the COMMITTED tree (git HEAD), not the working tree, so in-progress
# contract edits never leak into the server. Output: server/artifacts/out
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(git rev-parse --show-toplevel); H=artifacts/head
rm -rf "$H" && mkdir -p "$H"
git -C "$REPO" archive HEAD src script foundry.toml | tar -x -C "$H"
ln -s "$REPO/lib" "$H/lib"
FORGE=$(command -v forge || echo "$HOME/.foundry/bin/forge")
(cd "$H" && "$FORGE" build --skip test --out ../out --cache-path ../cache)
echo "artifacts built from $(git -C "$REPO" rev-parse --short HEAD)" | tee artifacts/COMMIT

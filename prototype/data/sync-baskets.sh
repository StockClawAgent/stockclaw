#!/bin/sh
# Copy Lucius's canonical basket file (repo root baskets.json) verbatim into the prototype's served folder.
set -e; cd "$(dirname "$0")"; cp ../../baskets.json baskets.json; python3 -c "import json;d=json.load(open('baskets.json'));print('synced',d.get('version'),len(d['baskets']),'baskets')"

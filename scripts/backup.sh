#!/usr/bin/env bash
# Download a full frank-memory backup (restorable from the dashboard's Backup section).
# /api/* is behind Cloudflare Access, so this uses an Access service token: create one in Zero Trust
# (Access > Service credentials), allow it in a Service Auth policy on the vault's Access application,
# and list its client ID in the Worker's ACCESS_SERVICE_TOKENS secret.
# Usage: FM_URL=https://memory.example.com CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… scripts/backup.sh [out-dir]
# Never prints secrets. Keeps the file only if it is a complete backup.
set -euo pipefail
U=${FM_URL:?set FM_URL to the vault origin, e.g. https://memory.example.com}
: "${CF_ACCESS_CLIENT_ID:?set CF_ACCESS_CLIENT_ID to the Access service token client ID}"
: "${CF_ACCESS_CLIENT_SECRET:?set CF_ACCESS_CLIENT_SECRET to the Access service token secret}"
OUT=${1:-.}
F="$OUT/frank-memory-backup-$(date -u +%Y-%m-%dT%H%M%SZ).json"
# The backup holds the whole vault: owner-only file, written to an unpredictable temp name first.
umask 077
P=$(mktemp "$OUT/.frank-memory-backup.XXXXXX")
trap 'rm -f "$P"' EXIT
# Headers go in on stdin so the secret never appears in the process list.
printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' "$CF_ACCESS_CLIENT_ID" "$CF_ACCESS_CLIENT_SECRET" |
  curl -fsS -H @- "$U/api/backup" -o "$P"
python3 - "$P" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("format") == "frank-memory-backup", "response is not a frank-memory backup (Access login page?)"
print(f"{len(d['memories'])} memories, {len(d['exclusions'])} exclusions, {len(d['batches'])} batches, guide v{d['guide']['version']}, made {d['exported_at']}")
PY
mv "$P" "$F"
echo "saved $F"

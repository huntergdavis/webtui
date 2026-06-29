#!/usr/bin/env bash
# Self-host the CheerpX engine (R5 / R-S1 / R-F1): download the pinned engine files into
# public/vendor/ so everything is served same-origin (Firefox COEP rejects cross-origin
# assets without CORP) and we control the exact bytes.
#
# The engine resolves its own assets relative to cx_esm.js's URL (a stack-trace base-URL
# trick), so serving them under /vendor/ is sufficient. File set determined 2026-06 by
# static analysis of cx_esm.js + HEAD probes of the CDN: *.js loaders + cxcore*.wasm carry
# content; cxbridge/cheerpOS/fail/tun .wasm are embedded in their .js and mirror as 0-byte
# (the CDN returns 204 for them — curl writes an empty file, which is faithful).
#
# Usage:
#   scripts/fetch-engine.sh           # download + (re)write the integrity manifest
#   scripts/fetch-engine.sh verify    # check vendored files against the committed manifest
set -euo pipefail

ENGINE_VERSION="1.2.8"
BASE="https://cxrtnc.leaningtech.com/${ENGINE_VERSION}"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"; cd "$repo_root"
VENDOR="public/vendor"
MANIFEST="$VENDOR/engine.manifest.json"

FILES=(
  cx.esm.js cx_esm.js
  cheerpOS.js cxbridge.js cxcore.js cxcore-no-return-call.js workerclock.js
  cxcore.wasm cxcore-no-return-call.wasm
  tun/tailscale_tun_auto.js
  fail.wasm cxbridge.wasm cheerpOS.wasm tun/tailscale_tun_auto.wasm
)

sri() { printf 'sha384-%s' "$(openssl dgst -sha384 -binary "$1" | openssl base64 -A)"; }

write_manifest() {
  local out="$1"
  {
    echo "{"
    echo "  \"version\": \"$ENGINE_VERSION\","
    echo "  \"source\": \"$BASE\","
    echo "  \"files\": {"
    local last=$(( ${#FILES[@]} - 1 )) i f comma
    for i in "${!FILES[@]}"; do
      f="${FILES[$i]}"; comma=","; [ "$i" -eq "$last" ] && comma=""
      printf '    "%s": "%s"%s\n' "$f" "$(sri "$VENDOR/$f")" "$comma"
    done
    echo "  }"
    echo "}"
  } > "$out"
}

if [ "${1:-}" = "verify" ]; then
  [ -f "$MANIFEST" ] || { echo "error: no manifest at $MANIFEST" >&2; exit 1; }
  fail=0
  for f in "${FILES[@]}"; do
    [ -f "$VENDOR/$f" ] || { echo "MISSING  $f"; fail=1; continue; }
    # Escape regex metachars in the filename ('.' would otherwise match '_', so
    # "cx.esm.js" would also match the "cx_esm.js" line and capture two hashes).
    fre="${f//./\\.}"
    want="$(grep -oE "\"$fre\": \"[^\"]+\"" "$MANIFEST" | head -1 | sed -E 's/.*: "([^"]+)"/\1/')"
    got="$(sri "$VENDOR/$f")"
    if [ "$want" = "$got" ]; then echo "ok       $f"; else echo "MISMATCH $f"; fail=1; fi
  done
  [ "$fail" -eq 0 ] && echo "==> engine integrity verified" || { echo "==> integrity check FAILED" >&2; exit 1; }
  exit 0
fi

command -v openssl >/dev/null || { echo "error: openssl required" >&2; exit 1; }

prev=""
if [ -f "$MANIFEST" ]; then prev="$(mktemp)"; cp "$MANIFEST" "$prev"; fi

echo "==> fetching CheerpX $ENGINE_VERSION into $VENDOR"
for f in "${FILES[@]}"; do
  mkdir -p "$VENDOR/$(dirname "$f")"
  curl -fsS -o "$VENDOR/$f" "$BASE/$f"
  printf '  %-34s %9s bytes\n' "$f" "$(wc -c < "$VENDOR/$f")"
done

write_manifest "$MANIFEST"
echo "==> wrote integrity manifest $MANIFEST"

# Pinning means a version/byte change must be a reviewed event (R-S1/R-S2), not silent.
if [ -n "$prev" ] && ! diff -q "$prev" "$MANIFEST" >/dev/null; then
  echo "!!  engine hashes changed vs previous manifest — REVIEW before committing:"
  diff "$prev" "$MANIFEST" || true
fi
[ -n "$prev" ] && rm -f "$prev"

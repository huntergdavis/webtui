#!/usr/bin/env bash
# fetch-fonts.sh — OPTIONAL: self-host the OpenDyslexic Mono webfont so the "legible"
# font option (settings panel, R-A5) uses the real dyslexia-friendly face instead of the
# fallback stack. CSP is font-src 'self', so the font MUST be self-hosted (no CDN).
#
# OpenDyslexic is free (SIL Open Font License). This fetches the woff2 into
# public/vendor/fonts/. If you skip this, the "OpenDyslexic / legible" option still works
# — it just falls back to Atkinson Hyperlegible / DejaVu Sans Mono via the @font-face
# fallback chain in style.css. Nothing breaks.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$repo_root/public/vendor/fonts"
out="$dest/OpenDyslexicMono-Regular.woff2"

# Override with a local/known-good URL if this one moves.
url="${OPENDYSLEXIC_URL:-https://github.com/antijingoist/opendyslexic/raw/master/compiled/OpenDyslexicMono-Regular.woff2}"

command -v curl >/dev/null || { echo "error: curl not found" >&2; exit 1; }
mkdir -p "$dest"

echo "==> fetching OpenDyslexic Mono -> $out"
echo "    source: $url"
if curl -fsSL "$url" -o "$out"; then
  echo "==> done ($(du -h "$out" | cut -f1)). The 'legible' font option now uses it."
else
  echo "error: download failed. The legible option will use its fallback stack until a" >&2
  echo "       woff2 is placed at $out (set OPENDYSLEXIC_URL to a working source)." >&2
  exit 1
fi

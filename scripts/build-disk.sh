#!/usr/bin/env bash
# Build a CheerpX-compatible read-only ext2 disk image from a Dockerfile.
#
# VERIFIED against CheerpX docs 2026-06 (https://cheerpx.io/docs/guides/custom-images,
# .../guides/File-System-support):
#   * The guest is 32-bit x86  -> base image platform is linux/386.
#   * Output is a SINGLE .ext2 file. There is NO chunk/index step: CheerpX streams
#     blocks on demand from the one file via HttpBytesDevice.create(url), layered over
#     an IDBDevice with OverlayDevice (Phase 3 / PLAN §4.2). The plan's older
#     CloudDevice + chunk_and_index() design is obsolete — CloudDevice was removed.
#   * The fs is built with:  mkfs.ext2 -b 4096 -d <rootfs-dir> <out.ext2> <size>
#
# Usage:  scripts/build-disk.sh [full|lite]   (default: full)
set -euo pipefail

variant="${1:-full}"
case "$variant" in
  full) dockerfile="Dockerfile";      out="public/disk/debian.ext2";      tag="webtui-rootfs:full" ;;
  lite) dockerfile="Dockerfile.lite"; out="public/disk/debian-lite.ext2"; tag="webtui-rootfs:lite" ;;
  *)    echo "usage: $0 [full|lite]" >&2; exit 2 ;;
esac

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

command -v docker    >/dev/null || { echo "error: docker not found" >&2; exit 1; }
command -v mkfs.ext2 >/dev/null || { echo "error: mkfs.ext2 (e2fsprogs) not found" >&2; exit 1; }
command -v fakeroot  >/dev/null || { echo "error: fakeroot not found" >&2; exit 1; }

rootfs="$(mktemp -d)"
trap 'rm -rf "$rootfs"' EXIT

echo "==> [$variant] docker build ($dockerfile, --platform linux/386)"
docker build --platform linux/386 -f "$dockerfile" -t "$tag" .

echo "==> create + export container rootfs"
cid="$(docker create --platform linux/386 "$tag")"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true; rm -rf "$rootfs"' EXIT

mkdir -p "$(dirname "$out")"

# Extract the rootfs and build the ext2 inside ONE fakeroot session, so root:root
# ownership from the container is recorded into the ext2 inodes (CheerpX runs the guest
# as uid 0). No real privilege escalation needed.
docker export "$cid" \
  | fakeroot bash -eu -o pipefail -c '
      rootfs="$1"; out="$2"; resolv="$3"
      tar -x --same-owner -p -C "$rootfs"
      # Seed /etc/resolv.conf here, not in the Dockerfile: Docker masks it on export
      # (see Dockerfile note). Under fakeroot this lands root:root 0644.
      install -m 0644 "$resolv" "$rootfs/etc/resolv.conf"
      used_mb=$(du -sm "$rootfs" | cut -f1)
      # Base is READ-ONLY (guest writes go to the IDB overlay), so size it to content
      # + 30% + 64MB slack only. Smaller base = less first-boot download (R9).
      size_mb=$(( used_mb * 13 / 10 + 64 ))
      echo "==> rootfs ${used_mb} MB -> ext2 ${size_mb} MB"
      rm -f "$out"
      mkfs.ext2 -q -F -b 4096 -d "$rootfs" "$out" "${size_mb}M"
    ' _ "$rootfs" "$out" "disk-src/resolv.conf"

echo "==> built:"
ls -lh "$out"
echo "==> done. Serve $out with HTTP range support; load via HttpBytesDevice (Phase 3)."

# check=skip=FromPlatformFlagConstDisallowed
# Full webtui rootfs — Debian i386 (CheerpX runs a 32-bit x86 guest).
# (We deliberately pin a constant linux/386 platform — we always want a 32-bit guest —
#  so the FromPlatformFlagConstDisallowed lint above is intentionally skipped.)
#
# VERIFIED against CheerpX docs 2026-06 (https://cheerpx.io/docs/guides/custom-images):
# the guest is 32-bit x86, so the base image platform must be linux/386. The resulting
# rootfs is turned into a single read-only ext2 by scripts/build-disk.sh and loaded in
# the browser with HttpBytesDevice + OverlayDevice (Phase 3 / PLAN §4.2).
#
# Keep this lean: the base ext2 is the read-only layer (all guest writes go to the IDB
# overlay), and every installed MB is potential first-boot download (R9). Heavier tools
# (full vim, python libs like textual) install at runtime once networking is up.
FROM --platform=linux/386 i386/debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get -y --no-install-recommends install \
      bash coreutils \
      git openssh-client ca-certificates \
      curl less vim-tiny \
      age \
      python3 \
      procps iproute2 iputils-ping \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/locale/* \
           /var/cache/apt/* /var/cache/debconf/*

# NOTE: /etc/resolv.conf is NOT seeded here. Docker special-cases it (and /etc/hosts,
# /etc/hostname): it bind-mounts its own copy at runtime, so `docker export` would emit
# a 0-byte file and mask anything we COPY. scripts/build-disk.sh seeds it from
# disk-src/resolv.conf into the extracted rootfs (under fakeroot) instead (PLAN §3, §6.5).

# Predictable root home.
RUN mkdir -p /root && chmod 700 /root
WORKDIR /root

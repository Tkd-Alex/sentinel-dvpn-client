#!/bin/bash
# postrm.sh
#
# Executed automatically as root by the package manager on removal:
#   deb:    apt remove / dpkg -r
#   rpm:    dnf remove / rpm -e
#   pacman: pacman -R
#
# On Debian-based systems this script receives an argument describing the
# removal phase ($1): "remove", "purge", "upgrade", "failed-upgrade", etc.
# We only do full cleanup on "remove" and "purge" — on "upgrade" the new
# postinst will re-create everything, so we skip teardown to avoid a gap
# where the service is stopped between the old and new package.
#
# rpm and pacman do not pass arguments — the script runs unconditionally.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

HELPER_DEST="/usr/local/lib/sentinel/sentinel-helper"
INSTALL_DIR="/usr/local/lib/sentinel"
UNIT_FILE="/etc/systemd/system/sentinel-helper.service"

# ---------------------------------------------------------------------------
# Debian upgrade guard
#
# If $1 is "upgrade" or "failed-upgrade", a new version of the package is
# being installed right after this removal. Leave the service running so
# there is no connectivity gap. The new postinst will restart it.
# ---------------------------------------------------------------------------

ACTION=$1
if [ -z "$ACTION" ]; then ACTION="remove"; fi

if [[ "$ACTION" == "upgrade" || "$ACTION" == "failed-upgrade" ]]; then
  echo "[postrm] Upgrade in progress — skipping service teardown."
  exit 0
fi

# ---------------------------------------------------------------------------
# Stop and disable the service
# ---------------------------------------------------------------------------

if command -v systemctl &>/dev/null; then
  # Stop: ignore error if the service is already stopped.
  systemctl stop sentinel-helper 2>/dev/null || true

  # Disable: ignore error if unit file is already gone.
  systemctl disable sentinel-helper 2>/dev/null || true

  echo "[postrm] sentinel-helper service stopped and disabled."
fi

# ---------------------------------------------------------------------------
# Remove unit file and binary
# ---------------------------------------------------------------------------

if [[ -f "$UNIT_FILE" ]]; then
  rm -f "$UNIT_FILE"
  echo "[postrm] Removed unit file: $UNIT_FILE"
fi

if [[ -f "$HELPER_DEST" ]]; then
  rm -f "$HELPER_DEST"
  echo "[postrm] Removed binary: $HELPER_DEST"
fi

# Remove the install directory only if it is now empty.
if [[ -d "$INSTALL_DIR" ]] && [[ -z "$(ls -A "$INSTALL_DIR")" ]]; then
  rmdir "$INSTALL_DIR"
  echo "[postrm] Removed empty directory: $INSTALL_DIR"
fi

# Reload systemd so it forgets the now-removed unit.
if command -v systemctl &>/dev/null; then
  systemctl daemon-reload 2>/dev/null || true
  systemctl reset-failed  2>/dev/null || true
fi

echo "[postrm] Done."

#!/bin/bash
# postinst.sh
#
# Executed automatically as root by the package manager after installation:
#   deb:    apt install / dpkg -i
#   rpm:    dnf install / rpm -i
#   pacman: pacman -U
#
# Responsibilities:
#   1. Copy sentinel-helper to a stable system path outside the package resources.
#   2. Write the systemd unit file.
#   3. Enable and start the service.
#
# electron-builder places package resources in:
#   deb/rpm:  /opt/<appName>/resources/
#   pacman:   /opt/<appName>/resources/
#
# The exact install prefix depends on the "linux.executableName" or "productName"
# in electron-builder.json. Adjust RESOURCES_DIR below if your app installs
# to a different location (check with: dpkg -L <package> | grep sentinel-helper).

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# Adjust this to match your electron-builder productName / executableName.
# electron-builder lowercases and replaces spaces with dashes by default.
APP_NAME="sentinel-dvpn"
RESOURCES_DIR="/opt/${APP_NAME}/resources"

HELPER_SRC="${RESOURCES_DIR}/sentinel-helper"
INSTALL_DIR="/usr/local/lib/sentinel"
HELPER_DEST="${INSTALL_DIR}/sentinel-helper"
UNIT_FILE="/etc/systemd/system/sentinel-helper.service"

# ---------------------------------------------------------------------------
# Sanity check
# ---------------------------------------------------------------------------

if [[ ! -f "${HELPER_SRC}" ]]; then
  echo "[postinst] Warning: sentinel-helper not found at ${HELPER_SRC}" >&2
  echo "[postinst] Skipping helper installation." >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Install binary
# ---------------------------------------------------------------------------

mkdir -p "${INSTALL_DIR}"
cp "${HELPER_SRC}" "${HELPER_DEST}"
chmod 755 "${HELPER_DEST}"
echo "[postinst] Installed sentinel-helper to ${HELPER_DEST}"

# ---------------------------------------------------------------------------
# Write systemd unit
# ---------------------------------------------------------------------------

cat > "${UNIT_FILE}" << EOF
[Unit]
Description=Sentinel Privileged Helper
Documentation=https://github.com/sentinel-official/dvpn-node
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${HELPER_DEST} --service
Restart=on-failure
RestartSec=3s
User=root
StandardOutput=journal
StandardError=journal
SyslogIdentifier=sentinel-helper
PrivateTmp=true
NoNewPrivileges=false

[Install]
WantedBy=multi-user.target
EOF

echo "[postinst] Unit file written to ${UNIT_FILE}"

# ---------------------------------------------------------------------------
# Enable and start the service
# ---------------------------------------------------------------------------

# systemctl may not be available in minimal container environments (e.g. during
# CI package testing). Guard with a check before calling it.
if command -v systemctl &>/dev/null && systemctl is-system-running --quiet 2>/dev/null; then
  systemctl daemon-reload
  systemctl enable sentinel-helper
  systemctl start sentinel-helper
  echo "[postinst] sentinel-helper service enabled and started."
else
  # Reload only — the service will start on next boot.
  systemctl daemon-reload 2>/dev/null || true
  echo "[postinst] systemd not running (container?). Service will start on next boot."
fi

echo "[postinst] Done."

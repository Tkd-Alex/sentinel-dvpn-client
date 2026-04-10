# Sentinel dVPN Desktop Client

## ⚠️ Disclaimer
This application is open source and was created for the Sentinel community. **100%** of the client code was created by AI. I wanted to play around a bit, but I just supervised. This shows how the power of the [sentinel-js-sdk](https://github.com/sentinel-official/sentinel-js-sdk/) combined with a tool like AI can create something amazing! A simple prompt like "create a VPN client using the SDK documented at https://sentinel-official.github.io/sentinel-js-sdk/: " is all it takes. The source of the nodes is: https://sentnodes.com/ Thanks! 💙 I'm not sure everything works perfectly, especially on Winzozz, but I'm pretty confident on Linux 😎.

A high-performance, cyberpunk-styled Desktop application for the [Sentinel](https://sentinel.co) Decentralized VPN network. Built with **Electron**, **React**, and **TypeScript**, this client provides a secure, private, and borderless internet experience using the Cosmos SDK ecosystem.

---

## ✨ Key Features

### 🌍 Global Multilingual Support (i18n)
Full internationalization support for **9 languages** with dynamic switching:
- **English, Italiano, Русский, Español, Deutsch, Français, 中文**
- **Persian (فارسی) & Arabic (العربية)**: Advanced **RTL (Right-to-Left)** support with full UI mirroring for a natural native experience.

### 🌐 Advanced Node Discovery
- **3D Interactive Globe**: Explore the Sentinel network via a smooth D3.js powered orthographic globe.
- **Advanced Filtering**: Filter by city, country, status (Active/Healthy), provider type (Residential), and Whitelist status.
- **Bookmarking**: Save your favourite nodes for instant access.

### 🔐 Uncompromising Security
- **Main Process Isolation**: Mnemonics and Private Keys are handled **exclusively** in the Main Process. They never cross the IPC bridge to the sandboxed Renderer.
- **OS-Native Encryption**: Credentials are encrypted via **Electron `safeStorage`**, utilizing the OS Keychain (macOS), DPAPI (Windows), or libsecret (Linux).
- **Hardened Sandboxing**: Renderer runs with `contextIsolation: true` and restricted API access.

### 🛡️ VPN Engines & Networking
- **WireGuard**: High-performance kernel-level tunnels with automated `sudo` escalation.
- **V2Ray**: Obfuscated proxy support (VMess/VLess) for bypassing restricted networks.
- **Transparent Proxy**: Route **all** system traffic through V2Ray using `tun2socks`.
- **Kill Switch**: Protection against IP leaks (supports `iptables`, `pf`, and `Windows Firewall`).
- **Split Tunneling**: Route only specific subnets through the VPN (WireGuard).
- **DNS over HTTPS (DoH)**: Custom DNS resolver support (Cloudflare, Google, NextDNS, etc.).

---

## 🛠️ Architecture & Flow

### 1. Connection Lifecycle
The app follows a surgical connection sequence:
```mermaid
graph LR
  A[Choose Node] --> B[Subscribing]
  B --> C[Handshaking]
  C --> D[Generating Config]
  D --> E[Tunnel Up]
```
**On-Chain Pricing**: Prices are always fetched directly from the blockchain (`udvpn`) to ensure real-time accuracy, bypassing API cache limitations.

### 2. Multi-Wallet Management
- Import multiple BIP-39 mnemonics.
- Live balance tracking for DVPN and IBC tokens.
- On-chain session monitoring: View and terminate active P2P sessions directly from the UI.

---

## 🚀 Getting Started

### Prerequisites
| Dependency | Purpose | Required for |
|-----------|---------|-------------|
| Node.js ≥ 18 | Build toolchain | Development |
| `wg-quick` | WireGuard management | WireGuard Nodes |
| `v2ray` | Proxy process | V2Ray Nodes |
| `tun2socks` | TUN interface | Transparent Mode |

### Installation (Development)
```bash
# Install dependencies
npm install

# Start in development mode (with hot-reload)
npm run dev

# Build the application
npm run build
```

---

## 📦 Distribution & Release

To generate executable binaries for ready use on Linux, Windows, and macOS:

### Prerequisites
- **Node.js & npm**
- **Linux Users**: To build for Windows from Linux, you need `wine` and `mono` installed.
- **macOS Users**: To build for macOS, you must be on a Mac machine.

### Automatic Build Script
Run the provided release script to package for all available platforms:
```bash
./release.sh
```

### Manual Build Commands
Alternatively, you can run individual scripts:
- **All platforms**: `npm run dist:all`
- **Linux**: `npm run dist:linux`
- **Windows**: `npm run dist:win`
- **macOS**: `npm run dist:mac`

The binaries will be located in the `dist/` directory.

---

| Target | Command | Output |
|--------|---------|--------|
| **Linux** | `npm run dist:linux` | `.deb`, `.AppImage` |
| **Windows** | `npm run dist:win` | `.exe` (NSIS) |
| **macOS** | `npm run dist:mac` | `.dmg` |

---

## 📁 Project Structure

```text
src/
├── main/             # System logic: SDK, Shell commands, Encryption, IPC
├── preload/          # Secure Context Bridge
└── renderer/         # React UI
    ├── locales/      # i18n JSON files (EN, IT, RU, FA, AR, ZH, ES, DE, FR)
    ├── components/
    │   ├── Globe     # 3D D3.js visualization
    │   ├── Nodes     # Advanced sorting & filtering tables
    │   ├── Wallet    # Management & Setup (BIP-39)
    │   └── Sessions  # On-chain session control
    └── styles/       # Cyberpunk CSS (Variable-based theme)
```

---

## 📜 Development Mandates (AI & Contributor Rules)
*As defined in `GEMINI.md`:*
1. **Mandatory Sync**: Every new string must be added to **all 9 locale files**.
2. **Surgical Edits**: Use `replace` for existing files; avoid placeholders.
3. **Secret Protection**: Never send mnemonics to the renderer via IPC.
4. **RTL Awareness**: Ensure layout integrity for Arab/Persian languages.

---

## ⚖️ License
Sentinel dVPN is an open-source project. Check the `LICENSE` file for more details.
Built with ❤️ by the Sentinel Community.

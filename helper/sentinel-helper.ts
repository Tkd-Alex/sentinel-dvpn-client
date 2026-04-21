/**
 * sentinel-helper.ts
 *
 * Privileged helper service for Sentinel. Runs as a Windows Service (LocalSystem)
 * or a systemd service (root on Linux), providing network operations that require
 * elevated privileges without prompting UAC or sudo at runtime.
 *
 * Communication model:
 *   TCP on 127.0.0.1:HELPER_PORT. Newline-delimited JSON messages in both directions.
 *   On Windows, the --namedpipe flag switches to \\.\pipe\sentinel-helper instead.
 *
 * Runtime modes:
 *   --service     Production. Started by the Windows SCM or systemd.
 *   --namedpipe   Windows Named Pipe transport (requires same integrity level).
 *   (no flags)    Development. TCP, run from an elevated terminal.
 *
 * Supported commands (all platforms unless noted):
 *   ping               → { status: 'pong' }
 *   start-transparent  → { status: 'ok', pid: number } | { status: 'error', error }
 *   stop-transparent   → { status: 'ok' }               | { status: 'error', error }
 *   set-kill-switch    → { status: 'ok' }               | { status: 'error', error }
 *
 * Kill switch — Windows:
 *   Sets the Windows Firewall default outbound policy to BLOCK, then adds named
 *   allow rules for the VPN server IP, TUN interface, loopback, and DHCP.
 *   The default policy is evaluated after explicit rules, so allow rules are
 *   true exceptions — unlike a block rule which would override them.
 *
 * Kill switch — Linux:
 *   Inserts a dedicated iptables chain (SENTINEL_KS) into OUTPUT, which drops
 *   all outbound traffic except the VPN server IP, the TUN interface, and loopback.
 *   Teardown removes the chain entirely, leaving the rest of iptables untouched.
 *
 * Build (CI produces platform-specific binaries via pkg):
 *   Windows: pkg dist-helper/sentinel-helper.js --target node18-win-x64   --output dist-helper/sentinel-helper.exe
 *   Linux:   pkg dist-helper/sentinel-helper.js --target node18-linux-x64 --output dist-helper/sentinel-helper
 */

import net  from 'net'
import path from 'path'
import { execSync, spawn, ChildProcess } from 'child_process'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HELPER_HOST = '127.0.0.1'
const HELPER_PORT = 47391
const PIPE_PATH   = '\\\\.\\pipe\\sentinel-helper'   // Windows only
const MAX_CONNECTIONS = 4

const IS_SERVICE_MODE = process.argv.includes('--service')
const USE_NAMED_PIPE  = process.argv.includes('--namedpipe')
const PLATFORM        = process.platform   // 'win32' | 'linux' | 'darwin'

// Windows TUN constants (Wintun adapter created by tun2socks)
const WIN_TUN_NAME    = 'sentinel-tun'
const WIN_TUN_ADDRESS = '10.0.0.1'
const WIN_TUN_NETMASK = '255.255.255.0'
const WIN_TUN_DNS     = '1.1.1.1'

// Linux TUN constants (kernel tun device created via ip tuntap)
const LIN_TUN_NAME    = 'sentun0'
const LIN_TUN_CIDR    = '10.0.0.1/24'

const TUN_WAIT_TIMEOUT_MS  = 20_000
const TUN_POLL_INTERVAL_MS = 500

// Windows Firewall kill switch rule prefix — all our rules share this prefix
// so they can be deleted as a group.
const KS_RULE_PREFIX = 'Sentinel-KS'
const KS_RULE_NAMES  = [
  `${KS_RULE_PREFIX}-Allow-Server`,
  `${KS_RULE_PREFIX}-Allow-TUN`,
  `${KS_RULE_PREFIX}-Allow-Loopback`,
  `${KS_RULE_PREFIX}-Allow-DHCP`,
]

// Linux iptables kill switch chain name.
const KS_CHAIN = 'SENTINEL_KS'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HelperCommand {
  command: string
  [key: string]: unknown
}

interface HelperResponse {
  status: 'ok' | 'error' | 'pong'
  error?: string
  [key: string]: unknown
}

interface StartTransparentPayload {
  /** Absolute path to tun2socks binary. */
  tun2socksPath: string
  /** SOCKS5 port v2ray is listening on. */
  socksPort: number
  /** Already-resolved IPv4 address of the V2Ray server. */
  serverIp: string
  /** Whether to enable the kill switch after the tunnel is up. Default false. */
  killSwitch?: boolean
}

interface SetKillSwitchPayload {
  enabled: boolean
}

// ---------------------------------------------------------------------------
// Active state
// ---------------------------------------------------------------------------

let activeTun2Socks: ChildProcess | null = null
let activeServerIp:  string | null = null
let killSwitchActive = false

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Writes a timestamped log line to stdout. In service mode the output is
 * captured by the Windows SCM or systemd journal. In dev mode it goes to the
 * elevated terminal.
 *
 * @param level  'INFO', 'WARN', or 'ERROR'.
 * @param msg    Human-readable message.
 * @param data   Optional extra data serialised as JSON.
 */
function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: unknown): void {
  const ts    = new Date().toISOString()
  const extra = data !== undefined ? ' ' + JSON.stringify(data) : ''
  console.log(`[${ts}] [${level}] [SentinelHelper] ${msg}${extra}`)
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Serialises a HelperResponse to a newline-terminated JSON string and writes
 * it to the socket. The newline is the message delimiter used by helper-client.ts.
 *
 * @param socket    Connected Electron client socket.
 * @param response  Response to send.
 */
function sendResponse(socket: net.Socket, response: HelperResponse): void {
  if (socket.destroyed) {
    log('WARN', 'Attempted to send response to a destroyed socket — skipping.')
    return
  }
  try { socket.write(JSON.stringify(response) + '\n') }
  catch (err) { log('ERROR', 'Failed to write response.', err) }
}

// ---------------------------------------------------------------------------
// Shared system helpers
// ---------------------------------------------------------------------------

/**
 * Runs a command synchronously and returns its trimmed stdout. stdio is always
 * 'pipe' so that no handles are inherited by child processes — inheriting handles
 * would cause Electron's TCP connection to block indefinitely (the original bug).
 *
 * @param cmd  Command string to execute.
 * @returns    Trimmed stdout.
 * @throws     Error if the command exits non-zero.
 */
function runCmd(cmd: string): string {
  log('INFO', `Executing: ${cmd}`)
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim()
}

/**
 * Polls until the named network interface appears in the OS, or until the
 * timeout expires. Used on both platforms after spawning tun2socks.
 *
 * On Windows it queries the adapter via netsh. On Linux it checks /sys/class/net.
 *
 * @param ifName     Interface name to wait for.
 * @param timeoutMs  Maximum wait in milliseconds.
 * @param intervalMs Poll interval in milliseconds.
 * @returns          Promise resolving to true if the interface appeared.
 */
function waitForInterface(
  ifName:     string,
  timeoutMs  = TUN_WAIT_TIMEOUT_MS,
  intervalMs = TUN_POLL_INTERVAL_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs

    const poll = (): void => {
      try {
        if (PLATFORM === 'win32') {
          execSync(`netsh interface show interface name="${ifName}"`, { stdio: 'pipe' })
        } else {
          execSync(`test -d /sys/class/net/${ifName}`, { stdio: 'pipe' })
        }
        log('INFO', `Interface "${ifName}" is now available.`)
        resolve(true)
        return
      } catch { /* not yet */ }

      if (Date.now() >= deadline) {
        log('WARN', `Interface "${ifName}" did not appear within ${timeoutMs} ms.`)
        resolve(false)
        return
      }
      setTimeout(poll, intervalMs)
    }

    poll()
  })
}

// ---------------------------------------------------------------------------
// Windows network helpers
// ---------------------------------------------------------------------------

/**
 * Reads the default gateway IP from the Windows routing table by parsing
 * `route print 0.0.0.0`. Needed to add the V2Ray server bypass route before
 * redirecting all traffic through the TUN — without it traffic to V2Ray would
 * enter the tunnel and cause an infinite routing loop.
 *
 * @returns Gateway IP string, or null if not found.
 */
function detectGatewayWindows(): string | null {
  try {
    const output = execSync('route print 0.0.0.0', { encoding: 'utf8', stdio: 'pipe' })
    const match  = output.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch (err) {
    log('WARN', 'Failed to run "route print 0.0.0.0".', err)
    return null
  }
}

/**
 * Retrieves the numeric Windows interface index of the Wintun adapter via
 * PowerShell's Get-NetIPInterface. Required by `route add ... IF <idx>`.
 *
 * @param tunName  Adapter name to look up.
 * @returns        Interface index, or null on failure.
 */
function getTunIndexWindows(tunName: string): number | null {
  try {
    const raw = execSync(
      `powershell -NoProfile -Command ` +
      `"(Get-NetIPInterface -InterfaceAlias '${tunName}' -AddressFamily IPv4 -ErrorAction Stop).InterfaceIndex"`,
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim()
    const idx = parseInt(raw, 10)
    return isNaN(idx) ? null : idx
  } catch (err) {
    log('WARN', 'Failed to retrieve TUN interface index.', err)
    return null
  }
}

/**
 * Removes routing entries added during start-transparent on Windows.
 * Errors on individual deletions are logged but do not throw — cleanup must
 * be best-effort because the TUN adapter may have already vanished.
 *
 * @param serverIp  V2Ray server IP whose bypass route must be deleted.
 */
function removeRoutesWindows(serverIp: string): void {
  for (const cmd of [
    `route delete ${serverIp}`,
    `route delete 0.0.0.0 mask 128.0.0.0`,
    `route delete 128.0.0.0 mask 128.0.0.0`,
  ]) {
    try { runCmd(cmd) }
    catch (err) { log('WARN', `Route removal failed (may already be gone): ${cmd}`, err) }
  }
}

// ---------------------------------------------------------------------------
// Linux network helpers
// ---------------------------------------------------------------------------

/**
 * Reads the default gateway and outbound interface from `ip route show default`.
 * Returns both values because Linux route add requires the interface name.
 * Filters out our own TUN interface name to avoid reading a stale entry.
 *
 * @returns Object with gateway IP and interface name, or null if not found.
 */
function detectGatewayLinux(): { gateway: string; iface: string } | null {
  try {
    const output = execSync(
      `ip route show default | grep -v '${LIN_TUN_NAME}' | head -n1`,
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim()
    // Format: "default via 192.168.1.1 dev eth0 proto dhcp metric 100"
    const parts = output.split(/\s+/)
    const viaIdx = parts.indexOf('via')
    const devIdx = parts.indexOf('dev')
    if (viaIdx === -1 || devIdx === -1) return null
    return { gateway: parts[viaIdx + 1], iface: parts[devIdx + 1] }
  } catch (err) {
    log('WARN', 'Failed to detect default gateway on Linux.', err)
    return null
  }
}

/**
 * Removes routing entries and the TUN interface added during start-transparent
 * on Linux. All commands use `|| true` semantics via try/catch so cleanup
 * continues even if individual steps fail.
 *
 * @param serverIp  V2Ray server IP whose bypass route must be deleted.
 * @param tunName   TUN interface name to tear down.
 */
function removeRoutesLinux(serverIp: string, tunName: string): void {
  for (const cmd of [
    `ip route del 0.0.0.0/1 dev ${tunName}`,
    `ip route del 128.0.0.0/1 dev ${tunName}`,
    `ip route del ${serverIp}`,
    `ip link set dev ${tunName} down`,
    `ip tuntap del dev ${tunName} mode tun`,
  ]) {
    try { runCmd(cmd) }
    catch (err) { log('WARN', `Linux route/interface removal failed: ${cmd}`, err) }
  }
}

// ---------------------------------------------------------------------------
// Windows kill switch
// ---------------------------------------------------------------------------

/**
 * Enables the Windows Firewall kill switch by setting the default outbound
 * policy to BLOCK and adding named allow rules for:
 *   - The V2Ray server IP (so the proxy connection survives)
 *   - The TUN adapter (so tunnelled traffic can leave)
 *   - Loopback 127.0.0.0/8 (localhost IPC must not break)
 *   - DHCP UDP 67/68 (physical NIC must renew its lease)
 *
 * The default policy is evaluated after all explicit rules, so allow rules
 * act as true exceptions — this is different from adding an explicit block
 * rule which would override them.
 *
 * @param serverIp  IPv4 address of the V2Ray server to exempt.
 * @throws          Error if any netsh command fails.
 */
function enableKillSwitchWindows(serverIp: string): void {
  if (killSwitchActive) {
    log('WARN', 'Kill switch already active — skipping enableKillSwitchWindows.')
    return
  }
  log('INFO', `Enabling Windows kill switch. Server IP exempt: ${serverIp}`)

  runCmd('netsh advfirewall set allprofiles firewallpolicy allowinbound,blockoutbound')
  runCmd(`netsh advfirewall firewall add rule name="${KS_RULE_PREFIX}-Allow-Server" dir=out action=allow protocol=any remoteip=${serverIp}`)
  runCmd(`netsh advfirewall firewall add rule name="${KS_RULE_PREFIX}-Allow-TUN" dir=out action=allow protocol=any interface="${WIN_TUN_NAME}"`)
  runCmd(`netsh advfirewall firewall add rule name="${KS_RULE_PREFIX}-Allow-Loopback" dir=out action=allow protocol=any remoteip=127.0.0.0/8`)
  runCmd(`netsh advfirewall firewall add rule name="${KS_RULE_PREFIX}-Allow-DHCP" dir=out action=allow protocol=UDP localport=68 remoteport=67`)

  killSwitchActive = true
  log('INFO', 'Windows kill switch enabled.')
}

/**
 * Disables the Windows Firewall kill switch by removing all Sentinel-KS-*
 * rules and restoring the default outbound policy to ALLOW. Safe to call even
 * if the kill switch was never enabled — it attempts orphan rule cleanup.
 */
function disableKillSwitchWindows(): void {
  log('INFO', 'Disabling Windows kill switch.')
  for (const name of KS_RULE_NAMES) {
    try { runCmd(`netsh advfirewall firewall delete rule name="${name}"`) }
    catch (err) { log('WARN', `Could not delete firewall rule "${name}".`, err) }
  }
  try { runCmd('netsh advfirewall set allprofiles firewallpolicy allowinbound,allowoutbound') }
  catch (err) { log('ERROR', 'Failed to restore default outbound policy.', err) }
  killSwitchActive = false
  log('INFO', 'Windows kill switch disabled.')
}

// ---------------------------------------------------------------------------
// Linux kill switch
// ---------------------------------------------------------------------------

/**
 * Enables the Linux kill switch using iptables. Creates a dedicated chain
 * SENTINEL_KS and inserts it into OUTPUT. The chain drops everything except:
 *   - Traffic to the V2Ray server IP
 *   - Traffic leaving via the TUN interface
 *   - Loopback (lo)
 *
 * Using a dedicated chain instead of modifying the default OUTPUT policy means:
 *   - We never touch rules that were there before us
 *   - Teardown is a single chain flush + delete — clean and atomic
 *   - If the helper crashes, the chain remains and blocks traffic (desired)
 *     and is cleaned up on the next start before creating a new one
 *
 * @param serverIp  IPv4 address of the V2Ray server to exempt.
 * @param tunName   TUN interface name to exempt.
 * @throws          Error if any iptables command fails.
 */
function enableKillSwitchLinux(serverIp: string, tunName: string): void {
  if (killSwitchActive) {
    log('WARN', 'Kill switch already active — skipping enableKillSwitchLinux.')
    return
  }
  log('INFO', `Enabling Linux kill switch. Server: ${serverIp}, TUN: ${tunName}`)

  // Clean up any orphaned chain from a previous crash before creating a new one.
  try { runCmd(`iptables -D OUTPUT -j ${KS_CHAIN}`) } catch { /* not present */ }
  try { runCmd(`iptables -F ${KS_CHAIN}`) }           catch { /* not present */ }
  try { runCmd(`iptables -X ${KS_CHAIN}`) }           catch { /* not present */ }

  runCmd(`iptables -N ${KS_CHAIN}`)

  // Allow rules must be inserted BEFORE the DROP catch-all at the end.
  runCmd(`iptables -A ${KS_CHAIN} -d ${serverIp} -j ACCEPT`)
  runCmd(`iptables -A ${KS_CHAIN} -o ${tunName} -j ACCEPT`)
  runCmd(`iptables -A ${KS_CHAIN} -o lo -j ACCEPT`)
  runCmd(`iptables -A ${KS_CHAIN} -j DROP`)

  // Insert our chain into OUTPUT before any existing rules.
  runCmd(`iptables -I OUTPUT -j ${KS_CHAIN}`)

  killSwitchActive = true
  log('INFO', 'Linux kill switch enabled.')
}

/**
 * Disables the Linux kill switch by removing the SENTINEL_KS chain from OUTPUT
 * and then flushing and deleting the chain. Safe to call even if never enabled.
 */
function disableKillSwitchLinux(): void {
  log('INFO', 'Disabling Linux kill switch.')
  try { runCmd(`iptables -D OUTPUT -j ${KS_CHAIN}`) }
  catch (err) { log('WARN', `Could not remove ${KS_CHAIN} from OUTPUT.`, err) }
  try { runCmd(`iptables -F ${KS_CHAIN}`) }
  catch (err) { log('WARN', `Could not flush ${KS_CHAIN}.`, err) }
  try { runCmd(`iptables -X ${KS_CHAIN}`) }
  catch (err) { log('WARN', `Could not delete ${KS_CHAIN}.`, err) }
  killSwitchActive = false
  log('INFO', 'Linux kill switch disabled.')
}

// ---------------------------------------------------------------------------
// Platform-agnostic kill switch dispatch
// ---------------------------------------------------------------------------

/**
 * Enables the kill switch for the current platform. Dispatches to the
 * platform-specific implementation.
 *
 * @param serverIp  V2Ray server IP to exempt.
 * @param tunName   TUN interface name to exempt (Linux only).
 */
function enableKillSwitch(serverIp: string, tunName: string): void {
  if (PLATFORM === 'win32') enableKillSwitchWindows(serverIp)
  else if (PLATFORM === 'linux') enableKillSwitchLinux(serverIp, tunName)
  else log('WARN', `Kill switch not implemented for platform: ${PLATFORM}`)
}

/**
 * Disables the kill switch for the current platform.
 */
function disableKillSwitch(): void {
  if (PLATFORM === 'win32') disableKillSwitchWindows()
  else if (PLATFORM === 'linux') disableKillSwitchLinux()
  else log('WARN', `Kill switch teardown not implemented for platform: ${PLATFORM}`)
}

// ---------------------------------------------------------------------------
// Platform handlers — Windows
// ---------------------------------------------------------------------------

/**
 * Windows implementation of start-transparent. Sets up the Wintun/tun2socks
 * transparent proxy by:
 *   1. Detecting the real default gateway.
 *   2. Adding a bypass route for the V2Ray server IP.
 *   3. Spawning tun2socks (stdio:'ignore' — critical, prevents handle leak).
 *   4. Waiting for the Wintun adapter to appear.
 *   5. Assigning IP/DNS to the adapter via netsh.
 *   6. Getting the adapter's interface index.
 *   7. Adding 0/1 + 128/1 default routes through the TUN.
 *   8. Enabling the kill switch if requested.
 *
 * @param socket   Connected client socket for sending the response.
 * @param payload  Validated StartTransparentPayload.
 */
async function startTransparentWindows(
  socket:  net.Socket,
  payload: StartTransparentPayload,
): Promise<void> {
  const { tun2socksPath, socksPort, serverIp, killSwitch = false } = payload
  let bypassRouteAdded = false

  try {
    const gateway = detectGatewayWindows()
    if (!gateway) throw new Error('Could not detect the default gateway.')
    log('INFO', `Gateway: ${gateway}`)

    runCmd(`route add ${serverIp} mask 255.255.255.255 ${gateway} METRIC 1`)
    bypassRouteAdded = true

    // stdio:'ignore' is critical — any inherited handle keeps the TCP connection
    // alive from the OS perspective, causing Electron's sendToHelper() to hang.
    const child = spawn(
      tun2socksPath,
      ['-device', `tun://${WIN_TUN_NAME}`, '-proxy', `socks5://127.0.0.1:${socksPort}`],
      { stdio: 'ignore', detached: false },
    )

    await new Promise<void>((resolve, reject) => {
      const w = setTimeout(resolve, 400)
      child.once('error', (e) => { clearTimeout(w); reject(new Error(`tun2socks failed to start: ${e.message}`)) })
      child.once('exit',  (c) => { clearTimeout(w); reject(new Error(`tun2socks exited immediately (code ${c ?? '?'}).`)) })
    })

    activeTun2Socks = child
    log('INFO', `tun2socks PID ${child.pid}`)
    child.on('exit', (code, sig) => { log('WARN', 'tun2socks exited.', { code, sig }); activeTun2Socks = null })

    const ready = await waitForInterface(WIN_TUN_NAME)
    if (!ready) throw new Error(`Wintun adapter "${WIN_TUN_NAME}" did not appear. Check wintun.dll.`)

    runCmd(`netsh interface ipv4 set address name="${WIN_TUN_NAME}" static ${WIN_TUN_ADDRESS} ${WIN_TUN_NETMASK} none`)
    runCmd(`netsh interface ipv4 set dnsservers name="${WIN_TUN_NAME}" static address=${WIN_TUN_DNS} register=none validate=no`)

    const ifIdx = getTunIndexWindows(WIN_TUN_NAME)
    if (ifIdx === null) throw new Error(`Could not get interface index for "${WIN_TUN_NAME}".`)

    runCmd(`route add 0.0.0.0 mask 128.0.0.0 ${WIN_TUN_ADDRESS} METRIC 2 IF ${ifIdx}`)
    runCmd(`route add 128.0.0.0 mask 128.0.0.0 ${WIN_TUN_ADDRESS} METRIC 2 IF ${ifIdx}`)

    activeServerIp = serverIp
    if (killSwitch) enableKillSwitch(serverIp, WIN_TUN_NAME)

    sendResponse(socket, { status: 'ok', pid: child.pid })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log('ERROR', 'Windows start-transparent failed. Rolling back.', { message })
    if (killSwitchActive) disableKillSwitch()
    if (activeTun2Socks) { try { activeTun2Socks.kill() } catch { /* best effort */ }; activeTun2Socks = null }
    if (bypassRouteAdded) removeRoutesWindows(serverIp)
    activeServerIp = null
    sendResponse(socket, { status: 'error', error: message })
  }
}

/**
 * Windows implementation of stop-transparent.
 * Disables kill switch → kills tun2socks → removes routes.
 * Order matters: kill switch is removed first so the user regains internet
 * access even if subsequent cleanup steps fail.
 *
 * @param socket  Connected client socket for sending the response.
 */
function stopTransparentWindows(socket: net.Socket): void {
  if (killSwitchActive) disableKillSwitch()

  if (activeTun2Socks) {
    try { activeTun2Socks.kill(); log('INFO', `tun2socks (PID ${activeTun2Socks.pid}) killed.`) }
    catch (err) {
      log('WARN', 'kill() failed, trying taskkill.', err)
      try { execSync('taskkill /f /im tun2socks.exe', { stdio: 'pipe' }) }
      catch { log('WARN', 'taskkill also failed.') }
    }
    activeTun2Socks = null
  }

  if (activeServerIp) { removeRoutesWindows(activeServerIp); activeServerIp = null }
}

// ---------------------------------------------------------------------------
// Platform handlers — Linux
// ---------------------------------------------------------------------------

/**
 * Linux implementation of start-transparent. Sets up a kernel TUN device and
 * tun2socks transparent proxy by:
 *   1. Detecting the default gateway and outbound interface.
 *   2. Creating and configuring the TUN device (ip tuntap / ip addr / ip link).
 *   3. Adding a bypass route for the V2Ray server IP.
 *   4. Spawning tun2socks.
 *   5. Waiting for the TUN device to appear in /sys/class/net.
 *   6. Adding 0/1 + 128/1 default routes through the TUN.
 *   7. Enabling the kill switch if requested.
 *
 * On Linux the TUN device is created by the helper (ip tuntap) before spawning
 * tun2socks, unlike Windows where Wintun is created by tun2socks itself.
 *
 * @param socket   Connected client socket.
 * @param payload  Validated StartTransparentPayload.
 */
async function startTransparentLinux(
  socket:  net.Socket,
  payload: StartTransparentPayload,
): Promise<void> {
  const { tun2socksPath, socksPort, serverIp, killSwitch = false } = payload
  const tunName = LIN_TUN_NAME
  let tunCreated = false
  let bypassRouteAdded = false

  try {
    const gw = detectGatewayLinux()
    if (!gw) throw new Error('Could not detect the default gateway on Linux.')
    const { gateway, iface } = gw
    log('INFO', `Gateway: ${gateway} via ${iface}`)

    // Create TUN device before spawning tun2socks (Linux requires this order).
    runCmd(`ip tuntap add dev ${tunName} mode tun`)
    runCmd(`ip addr add ${LIN_TUN_CIDR} dev ${tunName}`)
    runCmd(`ip link set dev ${tunName} up`)
    tunCreated = true
    log('INFO', `TUN device ${tunName} created and brought up.`)

    // Bypass route for V2Ray server — must exist before the 0/1 routes.
    runCmd(`ip route add ${serverIp} via ${gateway} dev ${iface}`)
    bypassRouteAdded = true

    // stdio:'ignore' — same reason as Windows: no inherited handles.
    const child = spawn(
      tun2socksPath,
      ['-device', `tun://${tunName}`, '-proxy', `socks5://127.0.0.1:${socksPort}`],
      { stdio: 'ignore', detached: false },
    )

    await new Promise<void>((resolve, reject) => {
      const w = setTimeout(resolve, 400)
      child.once('error', (e) => { clearTimeout(w); reject(new Error(`tun2socks failed: ${e.message}`)) })
      child.once('exit',  (c) => { clearTimeout(w); reject(new Error(`tun2socks exited immediately (code ${c ?? '?'}).`)) })
    })

    activeTun2Socks = child
    log('INFO', `tun2socks PID ${child.pid}`)
    child.on('exit', (code, sig) => { log('WARN', 'tun2socks exited.', { code, sig }); activeTun2Socks = null })

    const ready = await waitForInterface(tunName)
    if (!ready) throw new Error(`TUN device "${tunName}" did not appear in /sys/class/net.`)

    runCmd(`ip route add 0.0.0.0/1 dev ${tunName}`)
    runCmd(`ip route add 128.0.0.0/1 dev ${tunName}`)
    log('INFO', 'Default routes via TUN added. Transparent mode active.')

    activeServerIp = serverIp
    if (killSwitch) enableKillSwitch(serverIp, tunName)

    sendResponse(socket, { status: 'ok', pid: child.pid })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log('ERROR', 'Linux start-transparent failed. Rolling back.', { message })
    if (killSwitchActive) disableKillSwitch()
    if (activeTun2Socks) { try { activeTun2Socks.kill() } catch { /* best effort */ }; activeTun2Socks = null }
    if (bypassRouteAdded || tunCreated) removeRoutesLinux(serverIp, tunName)
    activeServerIp = null
    sendResponse(socket, { status: 'error', error: message })
  }
}

/**
 * Linux implementation of stop-transparent.
 *
 * @param socket  Connected client socket.
 */
function stopTransparentLinux(socket: net.Socket): void {
  if (killSwitchActive) disableKillSwitch()

  if (activeTun2Socks) {
    try { activeTun2Socks.kill(); log('INFO', `tun2socks (PID ${activeTun2Socks.pid}) killed.`) }
    catch (err) { log('WARN', 'Failed to kill tun2socks.', err) }
    activeTun2Socks = null
  }

  if (activeServerIp) { removeRoutesLinux(activeServerIp, LIN_TUN_NAME); activeServerIp = null }
}

// ---------------------------------------------------------------------------
// Command handlers (platform-agnostic entry points)
// ---------------------------------------------------------------------------

/** Handles 'ping'. @param socket Connected client socket. */
function handlePing(socket: net.Socket): void {
  log('INFO', 'Ping received — sending pong.')
  sendResponse(socket, { status: 'pong' })
}

/**
 * Handles 'start-transparent'. Dispatches to the platform implementation.
 * If the platform is unsupported, responds with an error immediately.
 *
 * @param socket   Connected client socket.
 * @param payload  Validated StartTransparentPayload.
 */
async function handleStartTransparent(
  socket:  net.Socket,
  payload: StartTransparentPayload,
): Promise<void> {
  if (activeTun2Socks !== null) {
    sendResponse(socket, { status: 'error', error: 'Transparent mode already active. Send stop-transparent first.' })
    return
  }

  if (PLATFORM === 'win32')        await startTransparentWindows(socket, payload)
  else if (PLATFORM === 'linux')   await startTransparentLinux(socket, payload)
  else sendResponse(socket, { status: 'error', error: `start-transparent not implemented for platform: ${PLATFORM}` })
}

/**
 * Handles 'stop-transparent'. Dispatches to the platform implementation.
 * Idempotent — calling when nothing is active returns ok.
 *
 * @param socket  Connected client socket.
 */
function handleStopTransparent(socket: net.Socket): void {
  if (activeTun2Socks === null && !killSwitchActive && activeServerIp === null) {
    log('INFO', 'stop-transparent called but nothing is active.')
    sendResponse(socket, { status: 'ok' })
    return
  }

  log('INFO', 'Stopping transparent mode.')

  if (PLATFORM === 'win32')       stopTransparentWindows(socket)
  else if (PLATFORM === 'linux')  stopTransparentLinux(socket)
  else { sendResponse(socket, { status: 'error', error: `stop-transparent not implemented for: ${PLATFORM}` }); return }

  log('INFO', 'Transparent mode stopped.')
  sendResponse(socket, { status: 'ok' })
}

/**
 * Handles 'set-kill-switch'. Enables or disables the kill switch at runtime
 * without requiring a full reconnect. Enabling requires transparent mode to
 * be active (we need activeServerIp for the allow rules).
 *
 * @param socket   Connected client socket.
 * @param payload  Validated SetKillSwitchPayload.
 */
function handleSetKillSwitch(socket: net.Socket, payload: SetKillSwitchPayload): void {
  if (payload.enabled) {
    if (activeServerIp === null) {
      sendResponse(socket, { status: 'error', error: 'Cannot enable kill switch: transparent mode is not active.' })
      return
    }
    try {
      const tunName = PLATFORM === 'win32' ? WIN_TUN_NAME : LIN_TUN_NAME
      enableKillSwitch(activeServerIp, tunName)
      sendResponse(socket, { status: 'ok' })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log('ERROR', 'enableKillSwitch failed.', { message })
      sendResponse(socket, { status: 'error', error: message })
    }
  } else {
    disableKillSwitch()
    sendResponse(socket, { status: 'ok' })
  }
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

/**
 * Validates a StartTransparentPayload from a raw HelperCommand.
 *
 * @param command  Raw HelperCommand from Electron.
 * @returns        Validated StartTransparentPayload.
 * @throws         Descriptive Error on any validation failure.
 */
function parseStartTransparentPayload(command: HelperCommand): StartTransparentPayload {
  const { tun2socksPath, socksPort, serverIp, killSwitch } = command as Record<string, unknown>
  if (typeof tun2socksPath !== 'string' || !tun2socksPath.trim())
    throw new Error('"tun2socksPath" must be a non-empty string.')
  if (typeof socksPort !== 'number' || !Number.isInteger(socksPort) || socksPort < 1 || socksPort > 65535)
    throw new Error('"socksPort" must be an integer between 1 and 65535.')
  if (typeof serverIp !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(serverIp))
    throw new Error('"serverIp" must be a dotted-decimal IPv4 address.')
  if (killSwitch !== undefined && typeof killSwitch !== 'boolean')
    throw new Error('Optional "killSwitch" must be a boolean.')
  return { tun2socksPath: tun2socksPath.trim(), socksPort, serverIp, killSwitch: killSwitch === true }
}

/**
 * Validates a SetKillSwitchPayload from a raw HelperCommand.
 *
 * @param command  Raw HelperCommand from Electron.
 * @returns        Validated SetKillSwitchPayload.
 * @throws         Descriptive Error on validation failure.
 */
function parseSetKillSwitchPayload(command: HelperCommand): SetKillSwitchPayload {
  const { enabled } = command as Record<string, unknown>
  if (typeof enabled !== 'boolean') throw new Error('"enabled" must be a boolean.')
  return { enabled }
}

// ---------------------------------------------------------------------------
// Command dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatches a parsed command to the appropriate handler. Unknown commands
 * receive an error response immediately so Electron never waits for a timeout.
 *
 * @param socket   Connected client socket.
 * @param command  Parsed HelperCommand.
 */
function processCommand(socket: net.Socket, command: HelperCommand): void {
  log('INFO', `Command: ${command.command}`, command)

  switch (command.command) {
    case 'ping':
      handlePing(socket)
      break

    case 'start-transparent': {
      let payload: StartTransparentPayload
      try { payload = parseStartTransparentPayload(command) }
      catch (err: unknown) { sendResponse(socket, { status: 'error', error: (err as Error).message }); return }
      handleStartTransparent(socket, payload).catch((err) => log('ERROR', 'Unhandled error in handleStartTransparent.', err))
      break
    }

    case 'stop-transparent':
      handleStopTransparent(socket)
      break

    case 'set-kill-switch': {
      let payload: SetKillSwitchPayload
      try { payload = parseSetKillSwitchPayload(command) }
      catch (err: unknown) { sendResponse(socket, { status: 'error', error: (err as Error).message }); return }
      handleSetKillSwitch(socket, payload)
      break
    }

    default:
      log('WARN', `Unknown command: ${command.command}`)
      sendResponse(socket, { status: 'error', error: `Unknown command: "${command.command}"` })
  }
}

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

/**
 * Handles one client connection. Accumulates data in a line buffer and
 * dispatches each complete newline-terminated JSON line as a command.
 *
 * @param socket  net.Socket from the server for this client.
 */
function handleConnection(socket: net.Socket): void {
  const label = `client@${socket.remoteAddress ?? 'pipe'}`
  log('INFO', `New connection: ${label}`)

  let buf = ''
  socket.setEncoding('utf8')

  socket.on('data', (chunk: string) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let command: HelperCommand
      try { command = JSON.parse(trimmed) as HelperCommand }
      catch { sendResponse(socket, { status: 'error', error: 'Malformed JSON.' }); continue }

      if (typeof command.command !== 'string') {
        sendResponse(socket, { status: 'error', error: 'Missing "command" string field.' })
        continue
      }
      processCommand(socket, command)
    }
  })

  socket.on('end',   ()  => log('INFO',  `${label} disconnected.`))
  socket.on('close', ()  => log('INFO',  `${label} socket closed.`))
  socket.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ECONNRESET') log('WARN', `${label} reset by peer.`)
    else log('ERROR', `Socket error from ${label}.`, { code: err.code, message: err.message })
  })
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Creates and starts the server. Uses Named Pipe on Windows if --namedpipe
 * was passed, TCP otherwise. On Linux, if the Unix socket file already exists
 * from a previous crash, it is removed before binding (TCP has no such issue).
 *
 * @returns Running net.Server instance.
 */
function createServer(): net.Server {
  const server = net.createServer({ allowHalfOpen: false })
  server.maxConnections = MAX_CONNECTIONS
  server.on('connection', handleConnection)
  server.on('error', (err: NodeJS.ErrnoException) => {
    log('ERROR', 'Server error.', { code: err.code, message: err.message })
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') { log('ERROR', 'Fatal bind error — exiting.'); process.exit(1) }
  })

  if (PLATFORM === 'win32' && USE_NAMED_PIPE) {
    server.listen(PIPE_PATH, () => log('INFO', `Named Pipe listening on ${PIPE_PATH}`))
  } else {
    server.listen(HELPER_PORT, HELPER_HOST, () => {
      log('INFO', `TCP listening on ${HELPER_HOST}:${HELPER_PORT}`)
      log('INFO', `Platform: ${PLATFORM} | Mode: ${IS_SERVICE_MODE ? 'service' : 'standalone (dev)'}`)
    })
  }

  return server
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Graceful shutdown. Always: disable kill switch → kill tun2socks → remove
 * routes → close server. The kill switch is disabled first so the user regains
 * internet access regardless of whether subsequent steps succeed.
 *
 * @param server  Running net.Server to close.
 * @param reason  Short label for why shutdown was triggered.
 */
function shutdown(server: net.Server, reason: string): void {
  log('INFO', `Shutdown: ${reason}`)

  if (killSwitchActive) disableKillSwitch()

  if (activeTun2Socks) {
    try { activeTun2Socks.kill() } catch { /* best effort */ }
    activeTun2Socks = null
  }

  if (activeServerIp) {
    if (PLATFORM === 'win32') removeRoutesWindows(activeServerIp)
    else if (PLATFORM === 'linux') removeRoutesLinux(activeServerIp, LIN_TUN_NAME)
    activeServerIp = null
  }

  server.close(() => { log('INFO', 'Server closed. Exiting.'); process.exit(0) })
  setTimeout(() => { log('WARN', 'Shutdown timed out — force-exiting.'); process.exit(1) }, 5000).unref()
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Main entry point. Creates the server and registers OS signal handlers.
 *
 *   SIGTERM   Windows SCM stop / systemd stop.
 *   SIGBREAK  Windows Ctrl+Break.
 *   SIGINT    Ctrl+C in dev mode.
 */
function main(): void {
  log('INFO', 'Sentinel Helper starting...')
  const server = createServer()

  process.on('SIGTERM',  () => shutdown(server, 'SIGTERM'))
  process.on('SIGBREAK', () => shutdown(server, 'SIGBREAK'))
  process.on('SIGINT',   () => shutdown(server, 'SIGINT'))

  process.on('uncaughtException', (err: Error) => {
    log('ERROR', 'Uncaught exception — keeping service alive.', { message: err.message, stack: err.stack })
    // Not exiting: a bug in one handler must not crash the service and leave
    // the kill switch or routes in an unclean state.
  })
  process.on('unhandledRejection', (reason: unknown) => {
    log('ERROR', 'Unhandled promise rejection.', { reason })
  })
}

main()
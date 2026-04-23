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

/** macOS utun interface name. Fixed to avoid searching for a free slot. */
const MAC_TUN_NAME   = 'utun10'

/**
 * Local (this end) and remote (peer/gateway) addresses for the macOS
 * point-to-point utun interface. Routes use MAC_TUN_PEER as their gateway.
 */
const MAC_TUN_LOCAL  = '10.0.0.1'
const MAC_TUN_PEER   = '10.0.0.2'

/**
 * Path to the temporary pf rules file written during kill switch enable.
 * Loaded into pf memory only — never touches /etc/pf.conf.
 */
const MAC_PF_RULES_FILE = '/tmp/sentinel-ks.pf'


/**
 * Records whether pf was already enabled before Sentinel activated the kill
 * switch. Used on teardown to decide whether to disable pf entirely (if we
 * enabled it) or to restore the previous ruleset (if it was already running).
 */
let pfWasEnabledBefore = false

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

/**
 * Payload for the 'wg-up' command. Instructs the helper to bring up a
 * WireGuard tunnel by installing it as a service (Windows) or running
 * wg-quick (Linux/macOS).
 */
interface WgUpPayload {
  /** Absolute path to the WireGuard config file (.conf). */
  configFile: string
  /**
   * Absolute path to wireguard.exe. Required on Windows because the binary
   * location is user-configured (checkBinaries in Electron resolves it).
   * Ignored on Linux/macOS.
   */
  wgPath?: string
}

/**
 * Payload for the 'wg-down' command. Instructs the helper to tear down
 * a WireGuard tunnel.
 */
interface WgDownPayload {
  /** Absolute path to the WireGuard config file (.conf). */
  configFile: string
  /** Same as WgUpPayload.wgPath — required on Windows only. */
  wgPath?: string
}

interface GetWgStatsResponse extends HelperResponse {
  rx?: number
  tx?: number
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
 * timeout expires. Platform-specific check:
 *   Windows: netsh interface show interface
 *   Linux:   /sys/class/net/<name> directory exists
 *   macOS:   ifconfig <name> exits 0
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
        } else if (PLATFORM === 'linux') {
          execSync(`test -d /sys/class/net/${ifName}`, { stdio: 'pipe' })
        } else {
          // macOS: ifconfig returns 0 if the interface exists, 1 if not.
          execSync(`ifconfig ${ifName}`, { stdio: 'pipe' })
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

/**
 * Detects the default gateway on macOS by parsing `route -n get default`.
 * The output contains a "gateway:" line with the IP address.
 *
 * @returns Gateway IP string, or null if not found.
 */
function detectGatewayMacOS(): string | null {
  try {
    const output = execSync('route -n get default', { encoding: 'utf8', stdio: 'pipe' })
    // Relevant line:  "   gateway: 192.168.1.1"
    const match = output.match(/gateway:\s+(\d+\.\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch (err) {
    log('WARN', 'Failed to detect default gateway on macOS.', err)
    return null
  }
}

/**
 * Removes routing entries added during start-transparent on macOS.
 * BSD route syntax differs from Linux — uses `route delete` without `ip`.
 * Errors are logged but do not throw.
 *
 * @param serverIp  V2Ray server IP whose host route must be deleted.
 */
function removeRoutesMacOS(serverIp: string): void {
  for (const cmd of [
    `route delete -host ${serverIp}`,
    `route delete -net 0.0.0.0/1`,
    `route delete -net 128.0.0.0/1`,
  ]) {
    try { runCmd(cmd) }
    catch (err) { log('WARN', `macOS route removal failed (may be gone): ${cmd}`, err) }
  }
}

/**
 * Determines whether a stderr string from wg-quick indicates a DNS
 * configuration failure. wg-quick on Linux fails with DNS errors when
 * resolvconf is not installed or when systemd-resolved is not available.
 * In that case Electron will ask the user whether to retry without DNS
 * injection (using a patched config file).
 *
 * @param stderr  The stderr output from the wg-quick invocation.
 * @returns       True if the error is DNS-related.
 */
function isWgDnsError(stderr: string): boolean {
  return (
    stderr.includes('resolvconf') ||
    stderr.includes('resolve1') ||
    stderr.includes('Failed to set DNS') ||
    stderr.includes('DNS')
  )
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
// macOS kill switch
// ---------------------------------------------------------------------------


/**
 * Enables the macOS kill switch using pf (Packet Filter).
 *
 * Writes a complete pf ruleset to MAC_PF_RULES_FILE and loads it into
 * memory with `pfctl -ef`. pf is NOT modified on disk — the rules exist
 * only until the next `pfctl -d` or system reboot.
 *
 * Rules allow:
 *   - Loopback (lo0) — Electron ↔ Helper IPC must not break
 *   - Traffic to the V2Ray server IP — the proxy must be able to connect
 *   - All traffic leaving via the TUN interface — tunnelled user data
 *   - DHCP (UDP 67/68) — physical NIC must renew its IP lease
 *
 * Everything else is blocked (drop policy).
 *
 * @param serverIp  IPv4 address of the V2Ray server to exempt.
 * @param tunName   utun interface name to exempt.
 * @throws          Error if pfctl fails.
 */
function enableKillSwitchMacOS(serverIp: string, tunName: string): void {
  if (killSwitchActive) {
    log('WARN', 'macOS kill switch already active — skipping.')
    return
  }

  // Record whether pf was enabled before we touched it.
  try {
    const info = execSync('pfctl -s info 2>/dev/null', { encoding: 'utf8', stdio: 'pipe' })
    pfWasEnabledBefore = info.includes('Status: Enabled')
  } catch {
    pfWasEnabledBefore = false
  }

  log('INFO', `Enabling macOS kill switch. pf was enabled: ${pfWasEnabledBefore}. Server: ${serverIp}`)

  const rules = [
    '# Sentinel kill switch — loaded by sentinel-helper, NOT saved to disk',
    'set block-policy drop',
    'set skip on lo0',
    'block out all',
    `pass out to ${serverIp}`,          // V2Ray server
    `pass out on ${tunName}`,           // TUN interface (tunnelled traffic)
    'pass out proto { tcp, udp } from any to any port { 67, 68 }', // DHCP
  ].join('\n')

  // Write to temp file — pfctl requires a file path, not stdin for -e.
  require('fs').writeFileSync(MAC_PF_RULES_FILE, rules, { encoding: 'utf8' })

  // -e enables pf, -f loads the rules file. Combined: pfctl -ef <file>.
  runCmd(`pfctl -ef ${MAC_PF_RULES_FILE}`)

  killSwitchActive = true
  log('INFO', 'macOS kill switch enabled.')
}

/**
 * Disables the macOS kill switch. Restores pf to its previous state:
 *   - If pf was enabled before Sentinel touched it: reload /etc/pf.conf
 *     (restores the original Apple-managed ruleset).
 *   - If pf was disabled before: disable it again with `pfctl -d`.
 *
 * Also removes the temporary rules file.
 */
function disableKillSwitchMacOS(): void {
  log('INFO', `Disabling macOS kill switch. Restoring pf state: was-enabled=${pfWasEnabledBefore}`)

  try {
    if (pfWasEnabledBefore) {
      // Restore original rules — flushes our kill switch rules.
      runCmd('pfctl -f /etc/pf.conf')
    } else {
      // pf was not running before us — disable it entirely.
      runCmd('pfctl -d')
    }
  } catch (err) {
    log('ERROR', 'Failed to restore pf state.', err)
  }

  // Clean up temp file.
  try { require('fs').unlinkSync(MAC_PF_RULES_FILE) } catch { /* may not exist */ }

  killSwitchActive = false
  pfWasEnabledBefore = false
  log('INFO', 'macOS kill switch disabled.')
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
  else if (PLATFORM === 'darwin') enableKillSwitchMacOS(serverIp, tunName)
  else if (PLATFORM === 'linux') enableKillSwitchLinux(serverIp, tunName)
  else log('WARN', `Kill switch not implemented for platform: ${PLATFORM}`)
}

/**
 * Disables the kill switch for the current platform.
 */
function disableKillSwitch(): void {
  if (PLATFORM === 'win32') disableKillSwitchWindows()
  else if (PLATFORM === 'darwin') disableKillSwitchMacOS()
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
// Platform handlers — macOS
// ---------------------------------------------------------------------------

/**
 * macOS implementation of start-transparent. Brings up transparent proxying:
 *
 *   1. Detect the default gateway via `route -n get default`.
 *   2. Spawn tun2socks with `-device utun10`. On macOS tun2socks creates the
 *      utun interface itself — no `ip tuntap` step needed (unlike Linux).
 *   3. Wait for utun10 to appear (ifconfig returns 0).
 *   4. Configure the point-to-point address with ifconfig.
 *   5. Add host route for V2Ray server via the real gateway.
 *   6. Add 0/1 and 128/1 routes via MAC_TUN_PEER (the utun peer address).
 *   7. Enable kill switch if requested.
 *
 * @param socket   Connected client socket for the response.
 * @param payload  Validated StartTransparentPayload.
 */
async function startTransparentMacOS(
  socket:  net.Socket,
  payload: StartTransparentPayload,
): Promise<void> {
  const { tun2socksPath, socksPort, serverIp, killSwitch = false } = payload
  const tunName = MAC_TUN_NAME
  let bypassRouteAdded = false

  try {
    const gateway = detectGatewayMacOS()
    if (!gateway) throw new Error('Could not detect the default gateway on macOS.')
    log('INFO', `Gateway: ${gateway}`)

    // Spawn tun2socks — it creates utun10 automatically on macOS.
    // stdio:'ignore' is critical for the same reason as Windows and Linux:
    // no inherited handles means no hanging await in Electron.
    const args = [
      '-device', tunName,
      '-proxy',  `socks5://127.0.0.1:${socksPort}`,
    ]
    log('INFO', `Spawning tun2socks: ${tun2socksPath} ${args.join(' ')}`)

    const child = spawn(tun2socksPath, args, { stdio: 'ignore', detached: false })

    await new Promise<void>((resolve, reject) => {
      const w = setTimeout(resolve, 400)
      child.once('error', (e) => { clearTimeout(w); reject(new Error(`tun2socks failed: ${e.message}`)) })
      child.once('exit',  (c) => { clearTimeout(w); reject(new Error(`tun2socks exited immediately (code ${c ?? '?'}).`)) })
    })

    activeTun2Socks = child
    log('INFO', `tun2socks PID ${child.pid}`)
    child.on('exit', (code, sig) => { log('WARN', 'tun2socks exited.', { code, sig }); activeTun2Socks = null })

    // Wait for utun10 to appear before configuring it.
    const ready = await waitForInterface(tunName)
    if (!ready) throw new Error(`utun interface "${tunName}" did not appear. Check tun2socks binary.`)

    // Configure point-to-point address. macOS utun is P2P: local <-> peer.
    runCmd(`ifconfig ${tunName} ${MAC_TUN_LOCAL} ${MAC_TUN_PEER} up`)
    log('INFO', `${tunName} configured: ${MAC_TUN_LOCAL} <-> ${MAC_TUN_PEER}`)

    // Bypass route for V2Ray server — must exist before the 0/1 routes.
    runCmd(`route add -host ${serverIp} ${gateway}`)
    bypassRouteAdded = true

    // Two /1 routes via the TUN peer address cover the full IPv4 space.
    // macOS route syntax uses the peer address as the gateway for utun.
    runCmd(`route add -net 0.0.0.0/1 ${MAC_TUN_PEER}`)
    runCmd(`route add -net 128.0.0.0/1 ${MAC_TUN_PEER}`)
    log('INFO', 'Default routes via TUN added. Transparent mode active.')

    activeServerIp = serverIp
    if (killSwitch) enableKillSwitch(serverIp, tunName)

    sendResponse(socket, { status: 'ok', pid: child.pid })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log('ERROR', 'macOS start-transparent failed. Rolling back.', { message })
    if (killSwitchActive) disableKillSwitch()
    if (activeTun2Socks) { try { activeTun2Socks.kill() } catch { /* best effort */ }; activeTun2Socks = null }
    if (bypassRouteAdded) removeRoutesMacOS(serverIp)
    activeServerIp = null
    sendResponse(socket, { status: 'error', error: message })
  }
}

/**
 * macOS implementation of stop-transparent.
 * Disables kill switch → kills tun2socks (destroys utun) → removes routes.
 *
 * @param socket  Connected client socket.
 */
function stopTransparentMacOS(socket: net.Socket): void {
  if (killSwitchActive) disableKillSwitch()

  if (activeTun2Socks) {
    try { activeTun2Socks.kill(); log('INFO', `tun2socks (PID ${activeTun2Socks.pid}) killed.`) }
    catch (err) { log('WARN', 'Failed to kill tun2socks.', err) }
    activeTun2Socks = null
  }

  if (activeServerIp) { removeRoutesMacOS(activeServerIp); activeServerIp = null }
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

  if (PLATFORM === 'win32') await startTransparentWindows(socket, payload)
  else if (PLATFORM === 'linux') await startTransparentLinux(socket, payload)
  else if (PLATFORM === 'darwin') await startTransparentMacOS(socket, payload)
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

  if (PLATFORM === 'win32') stopTransparentWindows(socket)
  else if (PLATFORM === 'linux') stopTransparentLinux(socket)
  else if (PLATFORM === 'darwin') stopTransparentMacOS(socket)
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

/**
 * Handles the 'wg-up' command. Brings up a WireGuard tunnel with elevated
 * privileges. The implementation differs by platform:
 *
 *   Windows: runs `wireguard.exe /installtunnelservice <configFile>`.
 *            wireguard.exe installs the tunnel as a Windows service under its
 *            own service manager — no UAC prompt needed because this helper
 *            already runs as SYSTEM via Task Scheduler.
 *
 *   Linux:   runs `wg-quick up <configFile>` as root.
 *            If the command fails with a DNS-related error, the response
 *            includes { isDnsError: true } so Electron can offer the user
 *            the option to retry with a patched config (DNS injection removed).
 *
 * The helper does NOT handle the DNS retry logic — that involves a UI dialog
 * and config file patching that belong in Electron. The helper simply reports
 * the error type and waits for Electron to call wg-up again with a fixed config.
 *
 * @param socket   Connected client socket for sending the response.
 * @param payload  Validated WgUpPayload.
 */
function handleWgUp(socket: net.Socket, payload: WgUpPayload): void {
  const { configFile, wgPath } = payload

  try {
    if (PLATFORM === 'win32') {
      const exe = wgPath || 'wireguard.exe'
      // /installtunnelservice takes the full config file path.
      // wireguard.exe derives the tunnel/service name from the filename.
      runCmd(`"${exe}" /installtunnelservice "${configFile}"`)
      sendResponse(socket, { status: 'ok' })

    } else if (PLATFORM === 'linux' || PLATFORM === 'darwin') {
      try {
        runCmd(`wg-quick up "${configFile}"`)
        sendResponse(socket, { status: 'ok' })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const dnsError = isWgDnsError(message)
        log(dnsError ? 'WARN' : 'ERROR', 'wg-quick up failed.', { message, dnsError })
        sendResponse(socket, {
          status: 'error',
          error: message,
          // Signals Electron to show the DNS retry dialog.
          isDnsError: dnsError,
        })
      }

    } else {
      sendResponse(socket, { status: 'error', error: `wg-up not implemented for platform: ${PLATFORM}` })
    }

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log('ERROR', 'handleWgUp failed.', { message })
    sendResponse(socket, { status: 'error', error: message })
  }
}

/**
 * Handles the 'wg-down' command. Tears down a WireGuard tunnel.
 *
 *   Windows: runs `wireguard.exe /uninstalltunnelservice <ifName>`.
 *            ifName is derived from the config file basename (without .conf).
 *
 *   Linux:   first checks whether the interface exists via `ip link show`.
 *            If the interface is already gone (e.g. due to a previous crash),
 *            returns ok immediately — teardown is idempotent.
 *            Otherwise runs `wg-quick down <configFile>`.
 *
 * @param socket   Connected client socket for sending the response.
 * @param payload  Validated WgDownPayload.
 */
function handleWgDown(socket: net.Socket, payload: WgDownPayload): void {
  const { configFile, wgPath } = payload
  // Derive the interface / tunnel name from the config filename.
  const ifName = path.basename(configFile, '.conf')

  try {
    if (PLATFORM === 'win32') {
      const exe = wgPath || 'wireguard.exe'
      try {
        runCmd(`"${exe}" /uninstalltunnelservice "${ifName}"`)
      } catch (err) {
        // If the tunnel service is already gone (e.g. previous crash), treat
        // it as success — wgDown is always idempotent from Electron's view.
        log('WARN', 'wg uninstalltunnelservice failed (may already be gone).', err)
      }
      sendResponse(socket, { status: 'ok' })

    } else if (PLATFORM === 'linux' || PLATFORM === 'darwin') {
      // Check whether the interface is still up before calling wg-quick down.
      // If it is already gone, return ok immediately.
      try {
        execSync(`ip link show ${ifName}`, { stdio: 'pipe' })
      } catch {
        log('INFO', `wg-down: interface ${ifName} already absent — nothing to do.`)
        sendResponse(socket, { status: 'ok' })
        return
      }

      try {
        runCmd(`wg-quick down "${configFile}"`)
      } catch (err) {
        log('WARN', 'wg-quick down failed.', err)
        // Still return ok — the interface check above confirmed it is gone
        // or wg-quick cleaned it up partially. Do not leave Electron hanging.
      }
      sendResponse(socket, { status: 'ok' })

    } else {
      sendResponse(socket, { status: 'error', error: `wg-down not implemented for platform: ${PLATFORM}` })
    }

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log('ERROR', 'handleWgDown failed.', { message })
    sendResponse(socket, { status: 'error', error: message })
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

/**
 * Validates a WgUpPayload from a raw HelperCommand.
 *
 * @param command  Raw HelperCommand from Electron.
 * @returns        Validated WgUpPayload.
 * @throws         Descriptive Error on validation failure.
 */
function parseWgUpPayload(command: HelperCommand): WgUpPayload {
  const { configFile, wgPath } = command as Record<string, unknown>
  if (typeof configFile !== 'string' || !configFile.trim())
    throw new Error('wg-up: "configFile" must be a non-empty string.')
  if (wgPath !== undefined && typeof wgPath !== 'string')
    throw new Error('wg-up: optional "wgPath" must be a string.')
  return { configFile: configFile.trim(), wgPath: wgPath as string | undefined }
}

/**
 * Validates a WgDownPayload from a raw HelperCommand.
 *
 * @param command  Raw HelperCommand from Electron.
 * @returns        Validated WgDownPayload.
 * @throws         Descriptive Error on validation failure.
 */
function parseWgDownPayload(command: HelperCommand): WgDownPayload {
  const { configFile, wgPath } = command as Record<string, unknown>
  if (typeof configFile !== 'string' || !configFile.trim())
    throw new Error('wg-down: "configFile" must be a non-empty string.')
  if (wgPath !== undefined && typeof wgPath !== 'string')
    throw new Error('wg-down: optional "wgPath" must be a string.')
  return { configFile: configFile.trim(), wgPath: wgPath as string | undefined }
}

function handleGetWgStats(socket: net.Socket): void {
  try {
    const output = execSync('wg show all transfer', { encoding: 'utf8', stdio: 'pipe' }).trim()
    let rx = 0, tx = 0
    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 3) {
        rx += parseInt(parts[1]) || 0
        tx += parseInt(parts[2]) || 0
      }
    }
    sendResponse(socket, { status: 'ok', rx, tx })
  } catch (err: unknown) {
    // wg may not be installed or no active tunnel — return zeros, not an error
    sendResponse(socket, { status: 'ok', rx: 0, tx: 0 })
  }
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

    case 'wg-up': {
      let payload: WgUpPayload
      try { payload = parseWgUpPayload(command) }
      catch (err: unknown) { sendResponse(socket, { status: 'error', error: (err as Error).message }); return }
      handleWgUp(socket, payload)
      break
    }

    case 'wg-down': {
      let payload: WgDownPayload
      try { payload = parseWgDownPayload(command) }
      catch (err: unknown) { sendResponse(socket, { status: 'error', error: (err as Error).message }); return }
      handleWgDown(socket, payload)
      break
    }

    case 'get-wg-stats':
      handleGetWgStats(socket)
    break

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
    else if (PLATFORM === 'darwin') removeRoutesMacOS(activeServerIp)
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
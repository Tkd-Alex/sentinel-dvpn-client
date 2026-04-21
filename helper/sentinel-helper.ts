/**
 * sentinel-helper.ts
 *
 * Privileged helper service for Sentinel. This process is intended to run as a
 * Windows Service under the LocalSystem account, giving it the elevated privileges
 * required to manipulate network routes, interfaces, and spawn network daemons
 * (tun2socks) without prompting UAC at runtime.
 *
 * Communication model:
 *   The Electron app connects to this helper via a Windows Named Pipe and exchanges
 *   newline-delimited JSON messages. Each message is a single JSON object on one line.
 *   The helper reads a command, executes it, and writes back a single JSON response.
 *
 * Runtime modes:
 *   --service   Production mode. Started by the Windows Service Control Manager (SCM).
 *               Registers SIGTERM/SIGBREAK handlers for clean SCM stop.
 *   (no flag)   Development mode. Run manually from an elevated terminal. Identical
 *               behaviour on the pipe side; no SCM integration.
 *
 * Pipe address:  \\.\pipe\sentinel-helper
 *
 * Supported commands:
 *   ping                 → { status: 'pong' }
 *   start-transparent    → { status: 'ok', pid: number } | { status: 'error', error: string }
 *   stop-transparent     → { status: 'ok' } | { status: 'error', error: string }
 *
 * Build:
 *   pkg dist-helper/sentinel-helper.js --target node18-win-x64 --output dist-helper/sentinel-helper.exe
 */

import net from 'net'
import { execSync, spawn, ChildProcess } from 'child_process'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Full Windows Named Pipe path. Must match the address used in helper-client.ts. */
const PIPE_PATH = '\\\\.\\pipe\\sentinel-helper'

/** TCP PIPE */
const HELPER_HOST = '127.0.0.1'
const HELPER_PORT = 47391

/** Maximum number of simultaneous client connections accepted by the server. */
const MAX_CONNECTIONS = 4

/** Whether this process was launched by the Windows SCM via the --service flag. */
const IS_SERVICE_MODE = process.argv.includes('--service')

/** TCP or Named Pipe */
const USE_NAMED_PIPE = process.argv.includes('--namedpipe')

/**
 * Name of the TUN adapter that tun2socks will create and manage.
 * Must match what Electron expects when polling for interface status.
 */
const TUN_NAME = 'sentinel-tun'

/** IP address assigned to the TUN adapter. The peer side is implicit. */
const TUN_ADDRESS = '10.0.0.1'
const TUN_NETMASK = '255.255.255.0'

/**
 * DNS server pushed onto the TUN interface so DNS queries also travel
 * through the tunnel when transparent mode is active.
 */
const TUN_DNS = '1.1.1.1'

/**
 * Maximum time to poll for the Wintun adapter to appear after spawning
 * tun2socks. On first use Wintun may need to install its kernel driver.
 */
const TUN_WAIT_TIMEOUT_MS = 20_000

/** Interval between TUN adapter existence checks in milliseconds. */
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A command message sent by the Electron app to the helper. */
interface HelperCommand {
  command: string
  [key: string]: unknown
}

/** A response message sent back from the helper to the Electron app. */
interface HelperResponse {
  status: 'ok' | 'error' | 'pong'
  error?: string
  [key: string]: unknown
}

/**
 * The payload Electron must include with the 'start-transparent' command.
 * Electron is responsible for resolving the V2Ray server hostname to an IP
 * before sending — the helper never performs DNS resolution itself.
 */
interface StartTransparentPayload {
  /** Absolute path to tun2socks.exe on the user's machine. */
  tun2socksPath: string
  /** SOCKS5 port that v2ray is listening on, from the v2ray inbounds config. */
  socksPort: number
  /** Already-resolved IPv4 address of the V2Ray server. No hostnames. */
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
let killSwitchActive = false

// ---------------------------------------------------------------------------
// Active process state
// ---------------------------------------------------------------------------

/**
 * Handle to the tun2socks child process while transparent mode is active.
 * Null when transparent mode is not running. The helper owns this process —
 * it is NOT a child of Electron. The helper kills it explicitly on
 * stop-transparent or on shutdown.
 */
let activeTun2Socks: ChildProcess | null = null

/**
 * The V2Ray server IP that was passed during start-transparent. Stored so
 * that stop-transparent can remove the correct bypass route without Electron
 * needing to pass the IP again.
 */
let activeServerIp: string | null = null

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Writes a timestamped log line to stdout. In service mode stdout is captured
 * by the SCM. In dev mode it prints to the terminal.
 *
 * @param level  Log level label: 'INFO', 'WARN', or 'ERROR'.
 * @param msg    The message string to log.
 * @param data   Optional extra data serialised as JSON alongside the message.
 */
function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: unknown): void {
  const ts = new Date().toISOString()
  const extra = data !== undefined ? ' ' + JSON.stringify(data) : ''
  console.log(`[${ts}] [${level}] [SentinelHelper] ${msg}${extra}`)
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Serialises a HelperResponse to a newline-terminated JSON string and writes
 * it to the given socket. The trailing newline is the message delimiter that
 * helper-client.ts uses to detect the end of a response.
 *
 * @param socket    The net.Socket representing the connected Electron client.
 * @param response  The response object to send.
 */
function sendResponse(socket: net.Socket, response: HelperResponse): void {
  if (socket.destroyed) {
    log('WARN', 'Attempted to send response to a destroyed socket, skipping.')
    return
  }
  try {
    socket.write(JSON.stringify(response) + '\n')
  } catch (err) {
    log('ERROR', 'Failed to serialise or write response.', err)
  }
}

// ---------------------------------------------------------------------------
// Windows network helpers
// ---------------------------------------------------------------------------

/**
 * Reads the default gateway IP from the Windows routing table by running
 * `route print 0.0.0.0` and parsing the first matching line.
 *
 * The helper needs the real physical gateway to add the V2Ray server bypass
 * route before redirecting all traffic through the TUN adapter. Without it,
 * V2Ray traffic would also enter the tunnel, causing an infinite routing loop.
 *
 * @returns The gateway IP string (e.g. '192.168.1.1'), or null if not found.
 */
function detectGateway(): string | null {
  try {
    const output = execSync('route print 0.0.0.0', { encoding: 'utf8', stdio: 'pipe' })
    // The relevant line format:
    //    0.0.0.0    0.0.0.0    192.168.1.1    192.168.1.100    25
    const match = output.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch (err) {
    log('WARN', 'Failed to run "route print 0.0.0.0".', err)
    return null
  }
}

/**
 * Runs a single command synchronously and returns its stdout as a trimmed string.
 * stdio is set to 'pipe' to prevent inheriting the helper's console handles —
 * any leaked handle reaching tun2socks would cause the same "await forever"
 * problem in Electron that this architecture is designed to eliminate.
 *
 * @param cmd  The command string to execute (e.g. 'route add 1.2.3.4 ...').
 * @returns    The trimmed stdout of the command.
 * @throws     Error if the command exits with a non-zero code.
 */
function runCmd(cmd: string): string {
  log('INFO', `Executing: ${cmd}`)
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim()
}

/**
 * Polls Windows until the Wintun adapter named TUN_NAME appears, or until the
 * timeout expires. tun2socks uses the Wintun kernel driver to create a virtual
 * adapter, which may take several seconds on first use while the driver installs.
 *
 * Uses `netsh interface show interface` rather than PowerShell so the poll is
 * fast and has no PowerShell startup overhead on each iteration.
 *
 * @param timeoutMs   Maximum time to wait in milliseconds.
 * @param intervalMs  How often to poll in milliseconds.
 * @returns           Promise resolving to true if the adapter appeared in time,
 *                    false if the timeout expired.
 */
function waitForTunAdapter(
  timeoutMs = TUN_WAIT_TIMEOUT_MS,
  intervalMs = TUN_POLL_INTERVAL_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs

    const poll = (): void => {
      try {
        execSync(`netsh interface show interface name="${TUN_NAME}"`, { stdio: 'pipe' })
        log('INFO', `TUN adapter "${TUN_NAME}" is now available.`)
        resolve(true)
        return
      } catch {
        // Not yet visible — continue if we still have time.
      }

      if (Date.now() >= deadline) {
        log('WARN', `TUN adapter "${TUN_NAME}" did not appear within ${timeoutMs} ms.`)
        resolve(false)
        return
      }

      setTimeout(poll, intervalMs)
    }

    poll()
  })
}

/**
 * Retrieves the numeric Windows interface index of the TUN adapter via
 * PowerShell's Get-NetIPInterface. The index is required by `route add` when
 * specifying the outbound interface with the `IF` parameter, and is more
 * reliable than using the adapter name directly in route.exe.
 *
 * @returns The interface index as a number, or null if it could not be read.
 */
function getTunInterfaceIndex(): number | null {
  try {
    const raw = execSync(
      `powershell -NoProfile -Command "(Get-NetIPInterface -InterfaceAlias '${TUN_NAME}' -AddressFamily IPv4 -ErrorAction Stop).InterfaceIndex"`,
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim()
    const idx = parseInt(raw, 10)
    return isNaN(idx) ? null : idx
  } catch (err) {
    log('WARN', 'Failed to retrieve TUN interface index via PowerShell.', err)
    return null
  }
}

/**
 * Attempts to remove all routes that were added during start-transparent.
 * Called by both stop-transparent and the rollback path inside
 * handleStartTransparent. Errors on individual route deletions are logged but
 * do not throw, so cleanup continues even if some routes were already removed
 * by the OS when the TUN adapter disappeared.
 *
 * @param serverIp  The V2Ray server IP whose bypass route must be deleted.
 */
function removeTransparentRoutes(serverIp: string): void {
  const cmds = [
    `route delete ${serverIp}`,
    `route delete 0.0.0.0 mask 128.0.0.0`,
    `route delete 128.0.0.0 mask 128.0.0.0`,
  ]
  for (const cmd of cmds) {
    try {
      runCmd(cmd)
    } catch (err) {
      log('WARN', `Route removal failed (may already be gone): ${cmd}`, err)
    }
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

/**
 * Handles the 'ping' command. Used by Electron to verify that the helper is
 * alive and ready before attempting any privileged operation.
 *
 * @param socket  The connected client socket to write the response to.
 */
function handlePing(socket: net.Socket): void {
  log('INFO', 'Received ping, sending pong.')
  sendResponse(socket, { status: 'pong' })
}

/**
 * Handles the 'start-transparent' command. Sets up transparent proxying on
 * Windows by executing these steps in order:
 *
 *   1. Detect the real default gateway from the Windows routing table.
 *   2. Add a host route for the V2Ray server IP via that gateway. This bypass
 *      route must exist before step 7 so V2Ray traffic does not loop into
 *      the tunnel it is supposed to carry.
 *   3. Spawn tun2socks as a direct child of this helper (not Electron). The
 *      process is spawned with stdio: 'ignore' so it inherits no open handles
 *      from Electron — this is the root cause of the original "await forever"
 *      bug and is the entire reason this helper architecture exists.
 *   4. Wait up to TUN_WAIT_TIMEOUT_MS for the Wintun virtual adapter to appear.
 *   5. Assign TUN_ADDRESS and TUN_DNS to the adapter via netsh.
 *   6. Retrieve the adapter's numeric interface index.
 *   7. Add two /1 default routes via the TUN adapter with a low metric so they
 *      attract all traffic in preference to the physical default route.
 *
 * If any step fails, all previously added routes are removed and tun2socks is
 * killed before the error response is sent, leaving the system in a clean state.
 *
 * @param socket   The connected client socket to write the response to.
 * @param payload  Validated StartTransparentPayload received from Electron.
 */
async function handleStartTransparent(
  socket: net.Socket,
  payload: StartTransparentPayload,
): Promise<void> {
  const { tun2socksPath, socksPort, serverIp, killSwitch = false } = payload

  if (activeTun2Socks !== null) {
    sendResponse(socket, {
      status: 'error',
      error: 'Transparent mode is already active. Send stop-transparent first.',
    })
    return
  }

  log('INFO', 'Starting transparent mode.', { serverIp, socksPort, tun2socksPath })

  // Track whether the bypass route was successfully added so the rollback
  // handler knows whether it needs to remove it.
  let bypassRouteAdded = false

  try {
    // Step 1 — detect real gateway.
    const gateway = detectGateway()
    if (!gateway) {
      throw new Error(
        'Could not detect the default gateway. ' +
        'Ensure at least one network interface has a default route.'
      )
    }
    log('INFO', `Detected default gateway: ${gateway}`)

    // Step 2 — add bypass route for V2Ray server.
    runCmd(`route add ${serverIp} mask 255.255.255.255 ${gateway} METRIC 1`)
    bypassRouteAdded = true
    log('INFO', `Bypass route added: ${serverIp} via ${gateway}`)

    // Step 3 — spawn tun2socks.
    //
    // stdio: 'ignore' is the critical setting here. If we used 'pipe' or
    // 'inherit', the OS would give tun2socks a reference to the same stdout/
    // stderr handles that Electron holds open through the Named Pipe connection.
    // Those handles would prevent the pipe from signalling EOF to Node, causing
    // Electron's await to hang indefinitely — the exact bug we are solving.
    //
    // detached: false keeps tun2socks in our process group. If the helper
    // service is stopped by the SCM, Windows terminates the group and
    // tun2socks goes with it automatically.
    const args = [
      '-device', `tun://${TUN_NAME}`,
      '-proxy', `socks5://127.0.0.1:${socksPort}`,
    ]
    log('INFO', `Spawning tun2socks: ${tun2socksPath} ${args.join(' ')}`)

    const child = spawn(tun2socksPath, args, { stdio: 'ignore', detached: false })

    // Give tun2socks a short window to emit an early error (binary not found,
    // wrong architecture, wintun.dll missing, etc.) before we proceed.
    await new Promise<void>((resolve, reject) => {
      const earlyWindow = setTimeout(resolve, 400)

      child.once('error', (err) => {
        clearTimeout(earlyWindow)
        reject(new Error(`tun2socks failed to start: ${err.message}`))
      })

      child.once('exit', (code) => {
        clearTimeout(earlyWindow)
        reject(new Error(`tun2socks exited immediately with code ${code ?? 'unknown'}.`))
      })
    })

    activeTun2Socks = child
    log('INFO', `tun2socks spawned with PID ${child.pid}`)

    // Log unexpected exits during normal operation so the user can diagnose
    // issues without needing to attach a debugger to the service.
    child.on('exit', (code, signal) => {
      log('WARN', 'tun2socks exited unexpectedly.', { code, signal })
      activeTun2Socks = null
    })

    // Step 4 — wait for Wintun adapter.
    const adapterReady = await waitForTunAdapter()
    if (!adapterReady) {
      throw new Error(
        `TUN adapter "${TUN_NAME}" did not appear within ${TUN_WAIT_TIMEOUT_MS} ms. ` +
        'Verify that wintun.dll is present in the same directory as tun2socks.exe.'
      )
    }

    // Step 5 — configure TUN adapter address and DNS.
    runCmd(
      `netsh interface ipv4 set address name="${TUN_NAME}" ` +
      `static ${TUN_ADDRESS} ${TUN_NETMASK} none`
    )
    runCmd(
      `netsh interface ipv4 set dnsservers name="${TUN_NAME}" ` +
      `static address=${TUN_DNS} register=none validate=no`
    )
    log('INFO', `TUN adapter configured: ${TUN_ADDRESS}/${TUN_NETMASK}, DNS ${TUN_DNS}`)

    // Step 6 — get interface index.
    const ifIdx = getTunInterfaceIndex()
    if (ifIdx === null) {
      throw new Error(
        `Could not retrieve interface index for "${TUN_NAME}". ` +
        'Cannot add default routes without it.'
      )
    }
    log('INFO', `TUN interface index: ${ifIdx}`)

    // Step 7 — add split default routes via TUN.
    //
    // Two /1 routes cover the entire IPv4 space and take precedence over the
    // physical default route because of the lower metric (2 vs. typical 25+).
    // We use two /1 routes instead of a single 0/0 because 0/0 would itself
    // be chosen as the "default" when the OS looks up where to send V2Ray
    // traffic, defeating the bypass route added in step 2.
    runCmd(`route add 0.0.0.0 mask 128.0.0.0 ${TUN_ADDRESS} METRIC 2 IF ${ifIdx}`)
    runCmd(`route add 128.0.0.0 mask 128.0.0.0 ${TUN_ADDRESS} METRIC 2 IF ${ifIdx}`)
    log('INFO', 'Default routes added via TUN. Transparent mode is active.')

    activeServerIp = serverIp
    if (killSwitch) enableKillSwitch(serverIp)
    sendResponse(socket, { status: 'ok', pid: child.pid })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log('ERROR', 'start-transparent failed. Rolling back.', { message })

    if (activeTun2Socks !== null) {
      try { activeTun2Socks.kill() } catch { /* best effort */ }
      activeTun2Socks = null
    }

    if (bypassRouteAdded) {
      removeTransparentRoutes(serverIp)
    }

    activeServerIp = null
    sendResponse(socket, { status: 'error', error: message })
  }
}

/**
 * Handles the 'stop-transparent' command. Tears down transparent mode by:
 *   1. Killing the tun2socks process owned by this helper. This also causes
 *      the Wintun adapter to disappear, which automatically removes the /1
 *      routes tied to it.
 *   2. Removing the V2Ray bypass route and explicitly removing the /1 routes
 *      in case the OS has not cleaned them up yet.
 *
 * This command is idempotent: calling it when transparent mode is not active
 * returns { status: 'ok' } without doing anything.
 *
 * @param socket  The connected client socket to write the response to.
 */
function handleStopTransparent(socket: net.Socket): void {
  if (activeTun2Socks === null) {
    log('INFO', 'stop-transparent called but no active session. Nothing to do.')
    sendResponse(socket, { status: 'ok' })
    return
  }

  log('INFO', 'Stopping transparent mode.')

  try {
    activeTun2Socks.kill()
    log('INFO', `tun2socks (PID ${activeTun2Socks.pid}) killed.`)
  } catch (err) {
    log('WARN', 'kill() failed, trying taskkill as fallback.', err)
    try {
      execSync('taskkill /f /im tun2socks.exe', { stdio: 'pipe' })
    } catch {
      log('WARN', 'taskkill also failed. tun2socks may have already exited.')
    }
  }
  activeTun2Socks = null

  if (activeServerIp !== null) {
    removeTransparentRoutes(activeServerIp)
    activeServerIp = null
  }

  log('INFO', 'Transparent mode stopped.')
  sendResponse(socket, { status: 'ok' })
}

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
function enableKillSwitch(serverIp: string): void {
  if (killSwitchActive) {
    log('WARN', 'Kill switch already active — skipping enableKillSwitch.')
    return
  }
  log('INFO', `Enabling Windows kill switch. Server IP exempt: ${serverIp}`)

  runCmd('netsh advfirewall set allprofiles firewallpolicy allowinbound,blockoutbound')
  runCmd(`netsh advfirewall firewall add rule name="${KS_RULE_PREFIX}-Allow-Server" dir=out action=allow protocol=any remoteip=${serverIp}`)
  runCmd(`netsh advfirewall firewall add rule name="${KS_RULE_PREFIX}-Allow-TUN" dir=out action=allow protocol=any interface="${TUN_NAME}"`)
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
function disableKillSwitch(): void {
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
      enableKillSwitch(activeServerIp)
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
 * Validates and type-narrows a StartTransparentPayload from a raw HelperCommand.
 * Returns the payload if valid, or throws a descriptive Error if any required
 * field is missing or of the wrong type. Validation happens before any privileged
 * operation so that malformed requests are rejected early with a clear message.
 *
 * @param command  The raw HelperCommand received from Electron.
 * @returns        A validated StartTransparentPayload.
 * @throws         Error with a human-readable message if validation fails.
 */
function parseStartTransparentPayload(command: HelperCommand): StartTransparentPayload {
  const { tun2socksPath, socksPort, serverIp } = command as Record<string, unknown>

  if (typeof tun2socksPath !== 'string' || tun2socksPath.trim() === '') {
    throw new Error('start-transparent: "tun2socksPath" must be a non-empty string.')
  }
  if (
    typeof socksPort !== 'number' ||
    !Number.isInteger(socksPort) ||
    socksPort < 1 ||
    socksPort > 65535
  ) {
    throw new Error('start-transparent: "socksPort" must be an integer between 1 and 65535.')
  }
  if (typeof serverIp !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(serverIp)) {
    throw new Error('start-transparent: "serverIp" must be a dotted-decimal IPv4 address.')
  }

  return { tun2socksPath: tun2socksPath.trim(), socksPort, serverIp }
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
 * Dispatches an incoming parsed command to the appropriate handler.
 * Unknown commands receive an error response immediately so that Electron
 * surfaces a useful message rather than waiting for a timeout.
 *
 * @param socket   The connected client socket — used to send the response.
 * @param command  The parsed HelperCommand object received from Electron.
 */
function processCommand(socket: net.Socket, command: HelperCommand): void {
  log('INFO', `Processing command: ${command.command}`, command)

  switch (command.command) {
    case 'ping':
      handlePing(socket)
      break

    case 'start-transparent': {
      let payload: StartTransparentPayload
      try {
        payload = parseStartTransparentPayload(command)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        sendResponse(socket, { status: 'error', error: message })
        return
      }
      // handleStartTransparent is async. We intentionally do not await it here
      // because the connection handler must remain responsive to other messages
      // while the async setup (adapter polling, netsh calls) is in progress.
      // Errors are caught inside the handler and converted to error responses.
      handleStartTransparent(socket, payload).catch((err) => {
        log('ERROR', 'Unhandled error escaping handleStartTransparent.', err)
      })
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
      log('WARN', `Unknown command received: ${command.command}`)
      sendResponse(socket, {
        status: 'error',
        error: `Unknown command: "${command.command}"`,
      })
  }
}

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

/**
 * Handles an individual client connection on the Named Pipe. Accumulates
 * incoming data in a line buffer, splitting on newlines so that partial pipe
 * writes do not cause JSON parse failures. Each complete line is parsed as a
 * JSON command and dispatched via processCommand().
 *
 * The same socket may carry multiple sequential commands across a single VPN
 * session (e.g. ping → start-transparent → stop-transparent).
 *
 * @param socket  The net.Socket created by the Named Pipe server for this client.
 */
function handleConnection(socket: net.Socket): void {
  const remoteLabel = `client@${socket.remoteAddress ?? 'pipe'}`
  log('INFO', `New connection from ${remoteLabel}`)

  let lineBuffer = ''
  socket.setEncoding('utf8')

  socket.on('data', (chunk: string) => {
    lineBuffer += chunk
    const lines = lineBuffer.split('\n')
    lineBuffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue

      let command: HelperCommand
      try {
        command = JSON.parse(trimmed) as HelperCommand
      } catch {
        log('ERROR', `Failed to parse JSON command: ${trimmed}`)
        sendResponse(socket, { status: 'error', error: 'Malformed JSON command.' })
        continue
      }

      if (typeof command.command !== 'string') {
        log('ERROR', 'Received message without a "command" string field.')
        sendResponse(socket, {
          status: 'error',
          error: 'Message must include a "command" string field.',
        })
        continue
      }

      processCommand(socket, command)
    }
  })

  socket.on('end', () => log('INFO', `${remoteLabel} disconnected (FIN received).`))

  socket.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ECONNRESET') {
      log('WARN', `${remoteLabel} connection reset by peer.`)
    } else {
      log('ERROR', `Socket error from ${remoteLabel}.`, { code: err.code, message: err.message })
    }
  })

  socket.on('close', () => log('INFO', `Socket for ${remoteLabel} fully closed.`))
}

// ---------------------------------------------------------------------------
// Named Pipe server
// ---------------------------------------------------------------------------

/**
 * Creates and starts the Windows Named Pipe server. Listens on PIPE_PATH
 * and calls handleConnection() for every incoming Electron client.
 *
 * @returns The running net.Server instance so the caller can close it on shutdown.
 */
function createPipeServer(): net.Server {
  const server = net.createServer({ allowHalfOpen: false })
  server.maxConnections = MAX_CONNECTIONS
  server.on('connection', handleConnection)

  server.on('error', (err: NodeJS.ErrnoException) => {
    log('ERROR', 'Named Pipe server error.', { code: err.code, message: err.message })
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
      log('ERROR', 'Fatal: cannot bind Named Pipe. Exiting.')
      process.exit(1)
    }
  })

  if(USE_NAMED_PIPE === true){
    server.listen(PIPE_PATH, () => {
      log('INFO', `Named Pipe server listening on ${PIPE_PATH}`)
      log('INFO', `Mode: ${IS_SERVICE_MODE ? 'Windows Service (SCM)' : 'Standalone (dev)'}`)
    })
  } else {
    server.listen(HELPER_PORT, HELPER_HOST, () => {
      log('INFO', `TCP server listening on ${HELPER_HOST}:${HELPER_PORT}`)
      log('INFO', `Mode: ${IS_SERVICE_MODE ? 'Windows Service (SCM)' : 'Standalone (dev)'}`)
    })
  }

  return server
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Performs a graceful shutdown. Kills tun2socks if running, removes any
 * active routes, then closes the Named Pipe server before exiting.
 *
 * @param server  The running net.Server to close before exiting.
 * @param reason  A short label describing why shutdown was triggered.
 */
function shutdown(server: net.Server, reason: string): void {
  log('INFO', `Shutdown requested. Reason: ${reason}`)

  if (activeTun2Socks !== null) {
    log('INFO', 'Killing active tun2socks process before shutdown.')
    try { activeTun2Socks.kill() } catch { /* best effort */ }
    activeTun2Socks = null
  }

  if (activeServerIp !== null) {
    removeTransparentRoutes(activeServerIp)
    activeServerIp = null
  }

  server.close(() => {
    log('INFO', 'Named Pipe server closed. Exiting.')
    process.exit(0)
  })

  setTimeout(() => {
    log('WARN', 'Shutdown timed out after 5 s. Force-exiting.')
    process.exit(1)
  }, 5000).unref()
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Main entry point. Creates the pipe server and registers OS signal handlers.
 *
 * Signal handling:
 *   SIGTERM  — Sent by the Windows SCM when the service is stopped.
 *   SIGBREAK — Windows Ctrl+Break in a console attached to the process.
 *   SIGINT   — Ctrl+C in dev mode from an elevated terminal.
 */
function main(): void {
  log('INFO', 'Sentinel Helper starting...')

  const server = createPipeServer()

  process.on('SIGTERM', () => shutdown(server, 'SIGTERM'))
  process.on('SIGBREAK', () => shutdown(server, 'SIGBREAK'))
  process.on('SIGINT', () => shutdown(server, 'SIGINT'))

  process.on('uncaughtException', (err: Error) => {
    log('ERROR', 'Uncaught exception — helper will continue running.', {
      message: err.message,
      stack: err.stack,
    })
    // Deliberately not exiting: a bug in one command handler must not bring
    // down the entire service and leave the user's network in a broken state.
  })

  process.on('unhandledRejection', (reason: unknown) => {
    log('ERROR', 'Unhandled promise rejection.', { reason })
  })
}

main()
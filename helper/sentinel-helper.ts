/**
 * sentinel-helper.ts
 *
 * Privileged helper service for Sentinel. This process is intended to run as a
 * Windows Service under the LocalSystem account, giving it the elevated privileges
 * required to manipulate network routes, interfaces, and spawn network daemons
 * (e.g. tun2socks) without prompting UAC at runtime.
 *
 * Communication model:
 *   The Electron app connects to this helper via a Windows Named Pipe and exchanges
 *   newline-delimited JSON messages. Each message is a single JSON object on one line.
 *   The helper reads a command, executes it, and writes back a single JSON response.
 *
 * Runtime modes:
 *   --service   Production mode. The process was started by the Windows Service Control
 *               Manager (SCM). Registers SIGTERM/SIGBREAK handlers for clean SCM stop.
 *   (no flag)   Development mode. Run manually from an elevated terminal. Identical
 *               behaviour on the pipe side; no SCM integration.
 *
 * Pipe address:  \\.\pipe\sentinel-helper
 *
 * Build:
 *   pkg dist-helper/sentinel-helper.js --target node18-win-x64 --output dist-helper/sentinel-helper.exe
 */

import net from 'net'
import process from 'process'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Full Windows Named Pipe path. Must match the address used in Electron. */
const PIPE_PATH = '\\\\.\\pipe\\sentinel-helper'

/** Maximum number of simultaneous client connections accepted by the server.
 *  In practice only one Electron instance will connect at a time, but we allow
 *  a small backlog so reconnection attempts during restart do not get refused. */
const MAX_CONNECTIONS = 4

/** Whether this process was launched by the Windows SCM via the --service flag. */
const IS_SERVICE_MODE = process.argv.includes('--service')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A command message sent by the Electron app to the helper.
 * Each message must include a `command` discriminator field.
 * Additional fields are command-specific.
 */
interface HelperCommand {
  command: string
  [key: string]: unknown
}

/**
 * A response message sent back from the helper to the Electron app.
 * `status` is always present. On success, optional extra fields may be included.
 * On failure, `error` contains a human-readable description.
 */
interface HelperResponse {
  status: 'ok' | 'error' | 'pong'
  error?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Writes a timestamped log line to stdout.
 * When running as a Windows Service, stdout is captured by the SCM and visible
 * in the Windows Event Log or in the service's log file if redirected.
 * In dev mode it simply prints to the terminal.
 *
 * @param level  Log level label, e.g. 'INFO', 'WARN', 'ERROR'.
 * @param msg    The message string to log.
 * @param data   Optional extra data to serialize as JSON alongside the message.
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
 * Serialises a HelperResponse object to a newline-terminated JSON string and
 * writes it to the given socket. The trailing newline is the message delimiter
 * that the Electron side uses to detect the end of a response.
 *
 * @param socket    The net.Socket representing the connected Electron client.
 * @param response  The response object to send.
 */
function sendResponse(socket: net.Socket, response: HelperResponse): void {
  if (socket.destroyed) {
    log('WARN', 'Attempted to send response to destroyed socket, skipping.')
    return
  }
  try {
    const raw = JSON.stringify(response) + '\n'
    socket.write(raw)
  } catch (err) {
    log('ERROR', 'Failed to serialise or write response', err)
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

/**
 * Handles the "ping" command. Used by Electron to verify that the helper is
 * alive and ready before attempting any privileged operation. The helper
 * responds immediately with { status: 'pong' }.
 *
 * @param socket  The connected client socket to write the response to.
 */
function handlePing(socket: net.Socket): void {
  log('INFO', 'Received ping, sending pong.')
  sendResponse(socket, { status: 'pong' })
}

/**
 * Dispatches an incoming parsed command to the appropriate handler function.
 * Unknown commands receive an error response so that Electron can surface a
 * useful message rather than timing out.
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

    // ------------------------------------------------------------
    // Future commands will be added here:
    //   case 'start-transparent': handleStartTransparent(socket, command); break
    //   case 'stop-transparent':  handleStopTransparent(socket);           break
    // ------------------------------------------------------------

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
 * Handles an individual client connection on the Named Pipe. Sets up a line
 * buffer to accumulate incoming data, splitting on newlines so that partial
 * TCP/pipe writes do not cause JSON parse failures. Each complete line is
 * parsed as a JSON command and dispatched via processCommand().
 *
 * The connection is intentionally stateless between commands: the same socket
 * may be reused by the Electron app to send multiple sequential commands
 * (e.g. ping → start-transparent → stop-transparent).
 *
 * @param socket  The net.Socket created by the Named Pipe server for this client.
 */
function handleConnection(socket: net.Socket): void {
  const remoteLabel = `client@${socket.remoteAddress ?? 'pipe'}`
  log('INFO', `New connection from ${remoteLabel}`)

  // Buffer accumulates raw bytes until a full newline-terminated line arrives.
  let lineBuffer = ''

  socket.setEncoding('utf8')

  socket.on('data', (chunk: string) => {
    lineBuffer += chunk

    // Process every complete line in the buffer. There may be zero, one, or
    // multiple complete lines in a single data event.
    const lines = lineBuffer.split('\n')

    // The last element is either empty (if the chunk ended with \n) or an
    // incomplete line. Either way, keep it in the buffer for the next chunk.
    lineBuffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue // skip blank lines

      let command: HelperCommand
      try {
        command = JSON.parse(trimmed) as HelperCommand
      } catch {
        log('ERROR', `Failed to parse JSON command: ${trimmed}`)
        sendResponse(socket, {
          status: 'error',
          error: 'Malformed JSON command.',
        })
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

  socket.on('end', () => {
    log('INFO', `${remoteLabel} disconnected (FIN received).`)
  })

  socket.on('error', (err: NodeJS.ErrnoException) => {
    // ECONNRESET is normal when the Electron app exits abruptly — log as WARN.
    if (err.code === 'ECONNRESET') {
      log('WARN', `${remoteLabel} connection reset by peer.`)
    } else {
      log('ERROR', `Socket error from ${remoteLabel}`, { code: err.code, message: err.message })
    }
  })

  socket.on('close', () => {
    log('INFO', `Socket for ${remoteLabel} fully closed.`)
  })
}

// ---------------------------------------------------------------------------
// Named Pipe server
// ---------------------------------------------------------------------------

/**
 * Creates and starts the Windows Named Pipe server. The server listens on
 * PIPE_PATH and calls handleConnection() for every incoming client.
 *
 * On Windows, if a previous server instance crashed without deleting the pipe,
 * the OS cleans it up automatically — unlike UNIX domain sockets. So we do not
 * need to unlink the path before binding.
 *
 * @returns The running net.Server instance, so the caller can close it on shutdown.
 */
function createPipeServer(): net.Server {
  const server = net.createServer({ allowHalfOpen: false })

  server.maxConnections = MAX_CONNECTIONS

  server.on('connection', handleConnection)

  server.on('error', (err: NodeJS.ErrnoException) => {
    log('ERROR', 'Named Pipe server error', { code: err.code, message: err.message })
    // If we cannot bind the pipe at all (e.g. access denied), exit with a
    // non-zero code so the SCM knows the service failed to start.
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
      log('ERROR', 'Fatal: cannot bind Named Pipe. Exiting.')
      process.exit(1)
    }
  })

  server.listen(PIPE_PATH, () => {
    log('INFO', `Named Pipe server listening on ${PIPE_PATH}`)
    log('INFO', `Mode: ${IS_SERVICE_MODE ? 'Windows Service (SCM)' : 'Standalone (dev)'}`)
  })

  return server
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Performs a graceful shutdown of the helper. Closes the Named Pipe server so
 * no new connections are accepted, then exits the process. In the future this
 * function will also kill any spawned tun2socks process and clean up routes.
 *
 * @param server  The running net.Server to close before exiting.
 * @param reason  A short human-readable label describing why shutdown was triggered.
 */
function shutdown(server: net.Server, reason: string): void {
  log('INFO', `Shutdown requested. Reason: ${reason}`)

  // TODO: when tun2socks management is implemented, stop the process here
  // and roll back routes before closing the server.

  server.close(() => {
    log('INFO', 'Named Pipe server closed. Exiting.')
    process.exit(0)
  })

  // Force-exit after 5 seconds if the server does not close cleanly.
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
 *   SIGTERM  — Sent by the Windows SCM when the service is stopped via
 *              services.msc or `sc stop`. Also used by node-process managers.
 *   SIGBREAK — Windows-specific signal sent when Ctrl+Break is pressed in a
 *              console attached to the process. Treated the same as SIGTERM.
 *   SIGINT   — Ctrl+C in dev mode. Triggers clean shutdown in the terminal.
 */
function main(): void {
  log('INFO', 'Sentinel Helper starting...')

  const server = createPipeServer()

  process.on('SIGTERM', () => shutdown(server, 'SIGTERM'))
  process.on('SIGBREAK', () => shutdown(server, 'SIGBREAK'))
  process.on('SIGINT', () => shutdown(server, 'SIGINT'))

  process.on('uncaughtException', (err: Error) => {
    log('ERROR', 'Uncaught exception — helper will continue running', {
      message: err.message,
      stack: err.stack,
    })
    // We deliberately do NOT exit on uncaught exceptions so that a bug in one
    // command handler does not take down the entire service. The Electron app
    // will receive an error response (or a socket error) and can retry.
  })

  process.on('unhandledRejection', (reason: unknown) => {
    log('ERROR', 'Unhandled promise rejection', { reason })
  })
}

main()
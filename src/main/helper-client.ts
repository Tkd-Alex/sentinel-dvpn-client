/**
 * helper-client.ts
 *
 * Electron main-process client for the sentinel-helper Windows Service.
 * Provides a single async function, sendToHelper(), that opens a Named Pipe
 * connection, sends a JSON command, waits for the JSON response, and closes
 * the connection. The call is fully typed and includes a configurable timeout
 * so the UI never hangs if the helper is not running.
 *
 * Usage:
 *   import { sendToHelper } from './helper-client'
 *
 *   const res = await sendToHelper({ command: 'ping' })
 *   if (res.status === 'pong') { ... }
 *
 * This module intentionally has no side effects at import time. It creates a
 * new pipe connection for every call — this is deliberately simple and correct
 * for the expected call frequency (a few times per VPN session). If you later
 * need streaming or push notifications from the helper, evolve to a persistent
 * connection managed separately.
 */

import net from 'net'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Must exactly match PIPE_PATH in sentinel-helper.ts. */
const PIPE_PATH = '\\\\.\\pipe\\sentinel-helper'

const HELPER_HOST = '127.0.0.1'
const HELPER_PORT = 47391

/**
 * Default timeout in milliseconds for a single sendToHelper() call.
 * If the helper does not respond within this window the promise rejects with
 * a timeout error. 10 s is generous enough for heavy operations (route setup)
 * while still providing a bounded wait for the UI.
 */
const DEFAULT_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A command object sent to the helper. The `command` field is the discriminator.
 * All other fields are command-specific and will be defined per-command as the
 * helper grows.
 */
export interface HelperCommand {
  command: string
  [key: string]: unknown
}

/**
 * A response received from the helper. Always contains `status`.
 * On error, `error` is a human-readable message. Additional fields
 * may be present depending on the command (e.g. `pid` after start-transparent).
 */
export interface HelperResponse {
  status: 'ok' | 'error' | 'pong'
  error?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Opens a Named Pipe connection to the sentinel-helper service, sends `command`
 * as a newline-terminated JSON string, reads the single-line JSON response, and
 * returns a parsed HelperResponse. The pipe connection is closed after each call.
 *
 * Failure modes — the promise always resolves to a HelperResponse, never rejects,
 * so callers do not need try/catch. On any error the returned object will have
 * `status: 'error'` and a descriptive `error` string.
 *
 * @param command     The command object to send. Must include a `command` string.
 * @param timeoutMs   How long to wait before giving up. Defaults to DEFAULT_TIMEOUT_MS.
 * @returns           A Promise that resolves to the HelperResponse from the service.
 */
export function sendToHelper(
  command: HelperCommand,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  useNamedPipe: boolean = false,
): Promise<HelperResponse> {
  return new Promise((resolve) => {
    // ---- internal helpers ------------------------------------------------

    /** Whether the promise has already been settled. Guards against double-resolve. */
    let settled = false

    /**
     * Settles the promise with a response and destroys the socket.
     * Safe to call multiple times — subsequent calls are ignored.
     *
     * @param response  The HelperResponse to resolve the promise with.
     */
    const finish = (response: HelperResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!socket.destroyed) socket.destroy()
      resolve(response)
    }

    // ---- timeout ---------------------------------------------------------

    /**
     * If the helper does not reply within timeoutMs, resolve with an error so
     * the caller (and therefore the UI) is never left hanging indefinitely.
     * This covers: helper not running, helper hung, SCM stopping the service.
     */
    const timer = setTimeout(() => {
      finish({
        status: 'error',
        error:
          `Helper did not respond within ${timeoutMs} ms. ` +
          'In development: make sure sentinel-helper is running in an elevated terminal. ' +
          'In production: the SentinelHelper Windows Service may be stopped.',
      })
    }, timeoutMs)

    // Keep the timer from preventing Node from exiting if Electron quits.
    if (typeof timer.unref === 'function') timer.unref()

    // ---- socket ----------------------------------------------------------

    const socket = useNamedPipe === true ? net.createConnection(PIPE_PATH) : net.createConnection(HELPER_PORT, HELPER_HOST)
    socket.setEncoding('utf8')

    /** Accumulates data chunks until a full newline-terminated line is received. */
    let lineBuffer = ''

    socket.on('connect', () => {
      // Pipe is open — send the command as a single JSON line.
      try {
        socket.write(JSON.stringify(command) + '\n')
      } catch (err) {
        finish({
          status: 'error',
          error: `Failed to serialise or write command: ${(err as Error).message}`,
        })
      }
    })

    socket.on('data', (chunk: string) => {
      lineBuffer += chunk

      // Look for a complete line. We only expect one response per call.
      const newlineIndex = lineBuffer.indexOf('\n')
      if (newlineIndex === -1) return // more data still coming

      const line = lineBuffer.slice(0, newlineIndex).trim()

      let parsed: HelperResponse
      try {
        parsed = JSON.parse(line) as HelperResponse
      } catch {
        finish({
          status: 'error',
          error: `Helper returned invalid JSON: ${line}`,
        })
        return
      }

      finish(parsed)
    })

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return // timeout already fired

      // ENOENT means the pipe does not exist — helper is not running.
      if (err.code === 'ENOENT') {
        finish({
          status: 'error',
          error:
            'Named Pipe not found. The SentinelHelper service is not running. ' +
            'In development: start it with "npm run dev:helper" in an elevated terminal.',
        })
      } if (err.code === 'ECONNREFUSED') {
        finish({
          status: 'error',
          error:
            'Connection refused on 127.0.0.1:47391. The SentinelHelper service is not running. ' +
            'In development: start it with "npm run dev:helper" in an elevated terminal.',
        })
      } else {
        finish({
          status: 'error',
          error: `Pipe connection error [${err.code ?? 'UNKNOWN'}]: ${err.message}`,
        })
      }
    })

    socket.on('close', () => {
      // Socket closed before we got a response (helper crashed mid-command, etc.)
      if (!settled) {
        finish({
          status: 'error',
          error: 'Pipe closed unexpectedly before a response was received.',
        })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Convenience: ping
// ---------------------------------------------------------------------------

/**
 * Sends a ping to the helper and returns true if it responds with "pong".
 * Useful as a pre-flight check before any privileged operation, and during
 * app startup to verify that the Windows Service is healthy.
 *
 * @param timeoutMs  Optional timeout override. Defaults to 3 s (shorter than
 *                   the default used for actual operations, since ping is instant).
 * @returns          True if the helper is alive, false otherwise.
 */
export async function pingHelper(timeoutMs = 3_000): Promise<boolean> {
  const res = await sendToHelper({ command: 'ping' }, timeoutMs)
  return res.status === 'pong'
}
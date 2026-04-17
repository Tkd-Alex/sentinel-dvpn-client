/**
 * elevated-channel.ts
 *
 * Risolve tre problemi distinti:
 *  1. Singola richiesta UAC  → ElevatedChannel (named pipe persistente)
 *  2. UI non si blocca       → nessuna execSync nel main process; tutto async
 *  3. Logging leggibile      → VpnLogger (file JSONL per processo + IPC al renderer)
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import * as net from 'net'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { spawn, ChildProcess, execSync } from 'child_process'
import { EventEmitter } from 'events'

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — ElevatedChannel
// ─────────────────────────────────────────────────────────────────────────────

const PIPE_NAME = `sentinel-helper-v1-${process.pid}`
const CONNECT_RETRIES = 40          // 40 × 500ms = 20s massimo
const CONNECT_INTERVAL_MS = 500
const REQUEST_TIMEOUT_MS = 90_000  // 90s hard timeout per singolo script

export interface ElevResult {
  id: string
  success: boolean
  stdout: string
  stderr: string
}

export interface ChannelDiagnosis {
  pipeConnected: boolean
  helperRunning: boolean
  executionPolicy: string
  helperLog: string
  summary: string
}

export class ElevatedChannel extends EventEmitter {
  private socket: net.Socket | null = null
  private recvBuffer = ''
  private pending = new Map<
    string,
    { resolve: (r: ElevResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  public helperLogPath: string

  constructor() {
    super()
    const logDir = path.join(app.getPath('userData'), 'logs', 'sentinel')
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
    this.helperLogPath = path.join(logDir, 'helper.log')
  }

  async run(script: string): Promise<ElevResult> {
    await this.ensureConnected()
    const id = crypto.randomBytes(4).toString('hex')

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ElevatedChannel: request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })

      const msg = JSON.stringify({ id, script }) + '\n'
      this.socket!.write(msg, 'utf8', (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new Error(`ElevatedChannel: write failed — ${err.message}`))
        }
      })
    })
  }

  disconnect() {
    this.socket?.destroy()
    this.socket = null
  }

  async diagnose(): Promise<ChannelDiagnosis> {
    const isRunning = await this.isHelperRunning()
    let policy = 'unknown'
    try {
      policy = execSync('powershell -NoProfile -Command Get-ExecutionPolicy', { encoding: 'utf8' }).trim()
    } catch {}

    const logTail = fs.existsSync(this.helperLogPath)
      ? fs.readFileSync(this.helperLogPath, 'utf8').split('\n').slice(-10).join('\n')
      : 'Log file not found'

    const problems: string[] = []
    if (!isRunning) problems.push('Helper process not found')
    if (this.socket === null) problems.push('Pipe not connected')
    if (policy === 'Restricted') problems.push('PowerShell ExecutionPolicy is Restricted')

    const summary = problems.length === 0
      ? 'Tutto OK'
      : 'Problemi rilevati:\n' + problems.map(p => '  - ' + p).join('\n')

    return {
      pipeConnected: !!this.socket,
      helperRunning: isRunning,
      executionPolicy: policy,
      helperLog: logTail,
      summary
    }
  }

  private async isHelperRunning(): Promise<boolean> {
    if (process.platform !== 'win32') return false
    try {
      const out = execSync(`tasklist /FI "IMAGENAME eq powershell.exe" /FO CSV`, { encoding: 'utf8' })
      return out.includes('sentinel-helper.ps1') || fs.existsSync(`\\\\.\\pipe\\${PIPE_NAME}`)
    } catch { return false }
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return
    if (await this.tryConnect()) return
    
    await this.launchHelper()
    
    for (let i = 0; i < CONNECT_RETRIES; i++) {
      if (await this.tryConnect()) return
      await sleep(CONNECT_INTERVAL_MS)
    }

    // Se fallisce, prova a leggere il log dell'helper per dare un errore migliore
    let extra = ''
    if (fs.existsSync(this.helperLogPath)) {
      const tail = fs.readFileSync(this.helperLogPath, 'utf8').split('\n').slice(-5).join('\n')
      extra = `\nLast helper logs:\n${tail}`
    } else {
      extra = `\nHelper log not found at ${this.helperLogPath}`
    }

    throw new Error(`ElevatedChannel: helper failed to connect after 20s. Potential ExecutionPolicy issue.${extra}`)
  }

  private tryConnect(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.createConnection(`\\\\.\\pipe\\${PIPE_NAME}`)
      sock.once('connect', () => {
        this.attachSocket(sock)
        resolve(true)
      })
      sock.once('error', () => resolve(false))
    })
  }

  private attachSocket(sock: net.Socket) {
    this.socket = sock
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      this.recvBuffer += chunk
      const lines = this.recvBuffer.split('\n')
      this.recvBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as ElevResult
          const entry = this.pending.get(msg.id)
          if (entry) {
            clearTimeout(entry.timer)
            this.pending.delete(msg.id)
            entry.resolve(msg)
          }
        } catch (e) { console.error('[ElevatedChannel] malformed response:', line, e) }
      }
    })
    sock.on('close', () => {
      this.socket = null
      this.emit('disconnected')
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`ElevatedChannel: connection closed during request ${id}`))
      }
      this.pending.clear()
    })
  }

  private async launchHelper(): Promise<void> {
    const tmpDir = app.getPath('temp')
    const scriptPath = path.join(tmpDir, 'sentinel-helper.ps1')
    
    // Assicurati che la directory dei log esista prima di lanciare
    const logDir = path.dirname(this.helperLogPath)
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })

    fs.writeFileSync(scriptPath, buildHelperScript(PIPE_NAME, this.helperLogPath), { encoding: 'utf8' })

    const innerCmd = `& "${scriptPath}"`
    const encodedInner = Buffer.from(innerCmd, 'utf16le').toString('base64')

    // Comando esterno che scatena UAC. Usiamo execSync per un trigger immediato.
    // Passiamo Bypass anche qui per sicurezza.
    const launchCmd = `Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NonInteractive','-EncodedCommand','${encodedInner}' -Verb RunAs -WindowStyle Hidden`
    
    try {
      // execSync qui non blocca la UI perché Start-Process torna immediatamente (non usiamo -Wait)
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${launchCmd.replace(/"/g, '\\"')}"`, { stdio: 'ignore' })
    } catch (e: any) {
      throw new Error(`Impossibile scatenare UAC: ${e.message}`)
    }
  }
}

function buildHelperScript(pipeName: string, logPath: string): string {
  const logEsc = logPath.replace(/\\/g, '\\\\')
  return `
#Requires -RunAsAdministrator
$ErrorActionPreference = "Continue"
$logFile = "${logEsc}"

function Write-HelperLog {
  param([string]$Level, [string]$Msg)
  $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff")
  $line = "[$ts][$Level] $Msg"
  try { 
    $dir = Split-Path $logFile
    if (-not (Test-Path $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 
  } catch {}
}
Write-HelperLog "INFO" "=== Helper started. Pipe: ${pipeName} ==="
try {
  $pipe = New-Object System.IO.Pipes.NamedPipeServerStream("${pipeName}", [System.IO.Pipes.PipeDirection]::InOut, 10, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::None)
  Write-HelperLog "INFO" "Waiting for client..."
  $pipe.WaitForConnection()
  Write-HelperLog "INFO" "Client connected"
  $reader = New-Object System.IO.StreamReader($pipe, [System.Text.Encoding]::UTF8)
  $writer = New-Object System.IO.StreamWriter($pipe, [System.Text.Encoding]::UTF8)
  $writer.AutoFlush = $true
  while ($pipe.IsConnected) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq "") { continue }
    $reqId = "unknown"; $success = $false; $stdout = ""; $stderr = ""
    try {
      $req = $line | ConvertFrom-Json
      $reqId = $req.id
      $script = $req.script
      Write-HelperLog "INFO" "Executing request $reqId"
      $sb = [scriptblock]::Create($script)
      $rawOut = & $sb 2>&1
      $stdout = ($rawOut | ForEach-Object { "$_" }) -join "\`n"
      $success = $true
      Write-HelperLog "INFO" "Request $reqId completed"
    } catch {
      $stderr = $_.Exception.ToString()
      $success = $false
      Write-HelperLog "ERROR" "Request $reqId failed: $($_.Exception.Message)"
    }
    $resp = [PSCustomObject]@{ id = $reqId; success = $success; stdout = $stdout; stderr = $stderr } | ConvertTo-Json -Compress -Depth 2
    $writer.WriteLine($resp)
  }
  Write-HelperLog "INFO" "Client disconnected, closing helper"
  $pipe.Dispose()
} catch { Write-HelperLog "ERROR" "Fatal: $($_.Exception.ToString())" }
`
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — VpnLogger
// ─────────────────────────────────────────────────────────────────────────────

export type ProcessName = 'v2ray' | 'tun2socks' | 'system'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: string
  process: ProcessName
  level: LogLevel
  msg: string
}

export class VpnLogger {
  private logDir: string
  private streams = new Map<ProcessName, fs.WriteStream>()
  private ringBuffer: LogEntry[] = []
  private readonly RING_SIZE = 500

  constructor() {
    this.logDir = path.join(app.getPath('userData'), 'logs', 'sentinel')
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true })
  }

  registerIpcHandlers(channel?: ElevatedChannel) {
    ipcMain.handle('vpn:log:tail', (_: unknown, proc: ProcessName, n = 100) => this.tail(proc, n))
    ipcMain.handle('vpn:log:dump', () => [...this.ringBuffer])
    
    if (channel) {
      ipcMain.handle('vpn:diagnose', async () => {
        const diag = await channel.diagnose()
        this.log('system', 'info', '[DIAGNOSI] ' + diag.summary.replace(/\n/g, ' | '))
        return diag
      })
    }
  }

  log(proc: ProcessName, level: LogLevel, msg: string) {
    const entry: LogEntry = { ts: new Date().toISOString(), process: proc, level, msg }
    const line = JSON.stringify(entry)
    this.getStream(proc).write(line + '\n')
    this.ringBuffer.push(entry)
    if (this.ringBuffer.length > this.RING_SIZE) this.ringBuffer.shift()
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send('vpn:log', entry)
    })
  }

  attach(proc: ProcessName, child: ChildProcess) {
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) =>
      chunk.split('\n').filter(Boolean).forEach((l) => this.log(proc, 'info', l.trimEnd()))
    )
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) =>
      chunk.split('\n').filter(Boolean).forEach((l) => this.log(proc, 'error', l.trimEnd()))
    )
    child.on('exit', (code, signal) => {
      this.log(proc, code === 0 || code === null ? 'info' : 'error', `Exited — code=${code}, signal=${signal}`)
    })
  }

  tail(proc: ProcessName, n = 100): LogEntry[] {
    const filePath = path.join(this.logDir, `${proc}.jsonl`)
    if (!fs.existsSync(filePath)) return []
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').slice(-n)
    return lines.flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  }

  private getStream(proc: ProcessName): fs.WriteStream {
    if (!this.streams.has(proc)) this.streams.set(proc, fs.createWriteStream(path.join(this.logDir, `${proc}.jsonl`), { flags: 'a' }))
    return this.streams.get(proc)!
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — setupTransparentV2RayWindows
// ─────────────────────────────────────────────────────────────────────────────

export async function setupTransparentV2RayWindows(opts: {
  serverIp: string; socksPort: number; tunInterface: string; tun2socksExe: string;
  channel: ElevatedChannel; logger: VpnLogger;
}): Promise<{ pid: number; realName: string }> {
  const { serverIp, socksPort, tunInterface, tun2socksExe, channel, logger } = opts
  const tmpDir = app.getPath('temp')
  const stdoutLog = path.join(tmpDir, `sentinel-tun2socks.stdout.log`)
  const stderrLog = path.join(tmpDir, `sentinel-tun2socks.stderr.log`)
  const pidFile = path.join(tmpDir, `sentinel-tun2socks.pid`)
  
  const esc = (p: string) => p.replace(/\\/g, '\\\\')
  const script = `
$ErrorActionPreference = "Stop"
$routeOut = (route print 0.0.0.0 | Out-String)
$gwMatch = [regex]::Match($routeOut, '0\\.0\\.0\\.0\\s+0\\.0\\.0\\.0\\s+(\\d+\\.\\d+\\.\\d+\\.\\d+)')
$gateway = if ($gwMatch.Success) { $gwMatch.Groups[1].Value } else { "0.0.0.0" }
Write-Host "[STEP 1] Gateway: $gateway"
route add ${serverIp} mask 255.255.255.255 $gateway METRIC 1 | Out-Null
$p = Start-Process -FilePath "${esc(tun2socksExe)}" -ArgumentList "-device tun://${tunInterface} -proxy socks5://127.0.0.1:${socksPort}" -RedirectStandardOutput "${esc(stdoutLog)}" -RedirectStandardError "${esc(stderrLog)}" -WindowStyle Hidden -PassThru
[System.IO.File]::WriteAllText("${esc(pidFile)}", $p.Id.ToString())
$adapter = $null; for ($i=0; $i -lt 30; $i++) { 
  $adapter = Get-NetAdapter | Where-Object { $_.Name -like "${tunInterface}*" } | Sort-Object Name -Descending | Select-Object -First 1
  if ($adapter) { break }
  if ($p.HasExited) { throw "tun2socks exited early" }
  Start-Sleep -Milliseconds 500
}
if (-not $adapter) { throw "TUN interface not found" }
$realName = $adapter.Name
$ifIdx = (Get-NetIPInterface -InterfaceAlias "$realName" -AddressFamily IPv4).InterfaceIndex
netsh interface ipv4 set address name="$realName" source=static addr=10.0.0.1 mask=255.255.255.0 | Out-Null
netsh interface ipv4 set dnsservers name="$realName" static address=1.1.1.1 register=none validate=no | Out-Null
route add 0.0.0.0 mask 128.0.0.0 10.0.0.1 METRIC 2 IF $ifIdx | Out-Null
route add 128.0.0.0 mask 128.0.0.0 10.0.0.1 METRIC 2 IF $ifIdx | Out-Null
Write-Host "[OK] RealName: $realName"
`
  logger.log('system', 'info', 'Starting Windows transparent setup via ElevatedChannel')
  const result = await channel.run(script)
  result.stdout.split('\n').filter(Boolean).forEach(l => logger.log('system', 'info', `[ps] ${l}`))
  if (!result.success) throw new Error(`Windows setup failed: ${result.stderr}`)
  
  let pid = 0; if (fs.existsSync(pidFile)) { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim()) || 0 }
  const realNameMatch = result.stdout.match(/RealName: (.+)/); const realName = realNameMatch ? realNameMatch[1].trim() : tunInterface
  
  tailLogFile(stdoutLog, 'tun2socks', 'info', logger)
  tailLogFile(stderrLog, 'tun2socks', 'error', logger)
  return { pid, realName }
}

function tailLogFile(filePath: string, proc: ProcessName, level: LogLevel, logger: VpnLogger) {
  let lastSize = 0
  const id = setInterval(() => {
    try {
      const stat = fs.statSync(filePath)
      if (stat.size <= lastSize) return
      const fd = fs.openSync(filePath, 'r'); const buf = Buffer.alloc(stat.size - lastSize)
      fs.readSync(fd, buf, 0, buf.length, lastSize); fs.closeSync(fd)
      lastSize = stat.size
      buf.toString('utf8').split('\n').filter(Boolean).forEach(l => logger.log(proc, level, l.trim()))
    } catch {}
  }, 2000)
  setTimeout(() => clearInterval(id), 15 * 60 * 1000)
}

export const elevatedChannel = new ElevatedChannel()
export const vpnLogger = new VpnLogger()
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

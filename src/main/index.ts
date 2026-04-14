import { app, BrowserWindow, ipcMain, shell, safeStorage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import Store from 'electron-store'
import {
  SentinelClient,
  SigningSentinelClient,
  nodeInfo,
  handshake,
  NodeEventCreateSession,
  NodeVPNType,
  V2Ray,
  Wireguard,
  searchEvent,
  nodeStartSession,
  sessionCancel,
  privKeyFromMnemonic,
  Session,
  BaseSession,
  type TxNodeStartSession,
  type Price
} from '@sentinel-official/sentinel-js-sdk'
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
import { assertIsDeliverTxSuccess } from '@cosmjs/stargate'
import Long from 'long'
import QRCode from 'qrcode'
import { spawn, spawnSync, execSync, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as dns from 'dns'
import * as crypto from 'crypto'

// ── GasPrice shim ────────────────────────────────────────────────────────────
function makeGasPrice(str: string): unknown {
  const sdkDir = require.resolve('@sentinel-official/sentinel-js-sdk').replace(/[/\\]dist[/\\].*/, '')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GasPrice } = require(sdkDir + '/node_modules/@cosmjs/stargate')
  return GasPrice.fromString(str)
}

// ── RPC list ─────────────────────────────────────────────────────────────────
export const RPC_LIST = [
  { label: 'Sentinel Official',            url: 'https://rpc.sentinel.co:443',           region: 'Global' },
  { label: 'Busurnode (Global)',           url: 'https://rpc-sentinel.busurnode.com:443',     region: 'NA/EU/AS' },
  { label: 'Sentinel Growth DAO (Global)', url: 'https://rpc.sentineldao.com:443',            region: 'NA/EU/AS' },
  { label: 'PublicNode',                   url: 'https://sentinel-rpc.publicnode.com:443',    region: 'NA/EU' },
  { label: 'MathNodes (Global)',           url: 'https://rpc.mathnodes.com:443',              region: 'NA/EU' },
  { label: 'Busurnode (NA)',               url: 'https://na-rpc-sentinel.busurnode.com:443',  region: 'NA' },
  { label: 'Sentinel DAO (NA)',            url: 'https://na-rpc.sentineldao.com:443',         region: 'NA' },
  { label: 'Busurnode (EU)',               url: 'https://eu-rpc-sentinel.busurnode.com:443',  region: 'EU' },
  { label: 'Busurnode (AS)',               url: 'https://as-rpc-sentinel.busurnode.com:443',  region: 'AS' },
  { label: 'Sentinel DAO (AS)',            url: 'https://as-rpc.sentineldao.com:443',         region: 'AS' },
  { label: 'Sentinel DAO (EU)',            url: 'https://eu-rpc.sentineldao.com:443',         region: 'EU' },
  { label: 'MathNodes (US)',               url: 'https://rpc.sentinel.noncompliance.org:443', region: 'US' },
  { label: 'Trinity Stake',               url: 'https://rpc.trinitystake.io:443',            region: 'NA' },
  { label: 'Polkachu',                    url: 'https://sentinel-rpc.polkachu.com:443',      region: 'EU' },
  { label: 'Quokka Stake',               url: 'https://rpc.sentinel.quokkastake.io:443',    region: 'EU' },
  { label: 'SuchNode',                    url: 'https://rpc.sentinel.suchnode.net:443',      region: 'EU' },
  { label: 'RoomIT',                      url: 'https://rpc.dvpn.roomit.xyz:443',            region: 'EU' },
  { label: 'MathNodes (RO)',              url: 'https://rpc.ro.mathnodes.com:443',           region: 'EU' },
]

// ── DoH resolvers ────────────────────────────────────────────────────────────
export const DOH_LIST = [
  { label: 'System Default',  ip: null },
  { label: 'Cloudflare',      ip: '1.1.1.1' },
  { label: 'Cloudflare WARP', ip: '1.0.0.1' },
  { label: 'Google',          ip: '8.8.8.8' },
  { label: 'Quad9',           ip: '9.9.9.9' },
  { label: 'NextDNS',         ip: '45.90.28.0' },
]

const DEFAULT_RPC        = RPC_LIST[0].url
const STORE_KEY_RPC      = 'selected_rpc'
const STORE_KEY_WALLETS  = 'wallets'
const STORE_KEY_ACTIVE_W = 'active_wallet'
const STORE_KEY_SETTINGS = 'settings'
const NODES_API          = 'https://api.sentnodes.com/v2/nodes'
const RPC_TIMEOUT_MS     = 10_000

// ── Defaults ──────────────────────────────────────────────────────────────────
interface AppSettings {
  killSwitch:     boolean
  autoReconnect:  boolean
  splitTunnel:    boolean
  splitRoutes:    string
  dohIp:          string | null
}
const DEFAULT_SETTINGS: AppSettings = {
  killSwitch:    false,
  autoReconnect: true,
  splitTunnel:   false,
  splitRoutes:   '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
  dohIp:         null,
}

const store = new Store({ name: 'sentinel-dvpn' })

// Cache for wallet addresses (encrypted mnemonic -> address)
const addressCache: Record<string, string> = {}

let mainWindow: BrowserWindow | null = null

let walletState: {
  address: string | null
  label: string
  privkey: Uint8Array | null
  client: SigningSentinelClient | null
  readonlyClient: SentinelClient | null
  rpc: string
} = { address: null, label: '', privkey: null, client: null, readonlyClient: null, rpc: DEFAULT_RPC }

let activeWgInstance:   Wireguard | null = null
let activeWgConfigFile: string | null    = null
let activeV2Ray:        V2Ray | null     = null
let activeTun2Socks:    ChildProcess | null = null
let activeTunInterface: string | null    = null
let activeV2RayServerIp: string | null    = null
let activeSessionId:    string | null    = null
let activeNodeAddress:  string | null    = null
let wasConnected:       boolean          = false

let trafficInterval: ReturnType<typeof setInterval> | null = null

let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let lastConnectArgs: { nodeAddress: string; subscriptionType: 'gigabytes' | 'hours'; amount: number } | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400, height: 880, minWidth: 1100, minHeight: 700,
    show: false, autoHideMenuBar: true,
    frame: false, transparent: false, backgroundColor: '#060810',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.sentinel.dvpn-client')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))
  registerIpcHandlers()
  createWindow()
})

app.on('window-all-closed', async () => {
  await killActiveConnections(true)
  if (process.platform !== 'darwin') app.quit()
})

function registerIpcHandlers(): void {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize())
  ipcMain.handle('window:close', async () => {
    if (activeSessionId) {
      mainWindow?.webContents.send('app:close-request')
      return
    }
    await killActiveConnections(true)
    mainWindow?.close()
  })

  ipcMain.handle('app:quit', async (_e, endSession: boolean) => {
    await killActiveConnections(endSession)
    mainWindow?.close()
  })

  ipcMain.handle('rpc:list', () => RPC_LIST)
  ipcMain.handle('rpc:get',  () => (store.get(STORE_KEY_RPC) as string | undefined) ?? DEFAULT_RPC)
  ipcMain.handle('rpc:set', async (_e, url: string) => {
    if (!RPC_LIST.find(r => r.url === url)) return { success: false, error: 'Unknown RPC' }
    store.set(STORE_KEY_RPC, url)
    walletState.rpc = url
    if (walletState.address) {
      const mn = getActiveMnemonic()
      if (mn) return setupWallet(mn, walletState.label, url)
    }
    return { success: true, url }
  })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    const cur = getSettings()
    const next = { ...cur, ...patch }
    store.set(STORE_KEY_SETTINGS, next)
    return { success: true, settings: next }
  })

  ipcMain.handle('binary:check', () => checkBinaries())
  ipcMain.handle('binary:install', async (_e, cmd: string) => {
    const res = execPrivileged([cmd])
    if (res.code === 0) return { success: true }
    return { success: false, error: res.stderr }
  })

  ipcMain.handle('wallet:list', async () => {
    const wallets = getWalletList()
    const active  = (store.get(STORE_KEY_ACTIVE_W) as number | undefined) ?? 0
    
    const list = await Promise.all(wallets.map(async (w, i) => {
      if (addressCache[w.encrypted]) {
        return { index: i, label: w.label, active: i === active, address: addressCache[w.encrypted] }
      }

      let address = ''
      const mn = decryptMnemonic(w.encrypted)
      if (mn) {
        try {
          const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mn.trim(), { prefix: 'sent' })
          const [acct] = await wallet.getAccounts()
          address = acct.address
          addressCache[w.encrypted] = address
        } catch (e) { console.error('Failed to get address for wallet', i, e) }
      }
      return { index: i, label: w.label, active: i === active, address }
    }))
    return list
  })

  ipcMain.handle('wallet:add', async (_e, mnemonic: string, label: string) => {
    const rpc = (store.get(STORE_KEY_RPC) as string | undefined) ?? DEFAULT_RPC
    const result = await setupWallet(mnemonic, label, rpc)
    if (!result.success) return result
    const wallets = getWalletList()
    const encrypted = encryptMnemonic(mnemonic.trim())
    wallets.push({ label, encrypted })
    store.set(STORE_KEY_WALLETS, wallets)
    store.set(STORE_KEY_ACTIVE_W, wallets.length - 1)
    return { success: true, address: result.address, label }
  })

  ipcMain.handle('wallet:switch', async (_e, index: number) => {
    const wallets = getWalletList()
    if (index < 0 || index >= wallets.length) return { success: false, error: 'Invalid wallet index' }
    const mn = decryptMnemonic(wallets[index].encrypted)
    if (!mn) return { success: false, error: 'Failed to decrypt wallet' }
    const rpc = (store.get(STORE_KEY_RPC) as string | undefined) ?? DEFAULT_RPC
    const result = await setupWallet(mn, wallets[index].label, rpc)
    if (result.success) store.set(STORE_KEY_ACTIVE_W, index)
    return result
  })

  ipcMain.handle('wallet:remove', (_e, index: number) => {
    const wallets = getWalletList()
    if (wallets.length <= 1) return { success: false, error: 'Cannot remove last wallet' }
    wallets.splice(index, 1)
    store.set(STORE_KEY_WALLETS, wallets)
    const active = Math.min((store.get(STORE_KEY_ACTIVE_W) as number) ?? 0, wallets.length - 1)
    store.set(STORE_KEY_ACTIVE_W, active)
    return { success: true }
  })

  ipcMain.handle('wallet:rename', (_e, index: number, label: string) => {
    const wallets = getWalletList()
    if (index < 0 || index >= wallets.length) return { success: false, error: 'Invalid wallet index' }
    wallets[index].label = label
    store.set(STORE_KEY_WALLETS, wallets)
    const active = (store.get(STORE_KEY_ACTIVE_W) as number | undefined) ?? 0
    if (index === active) {
      mainWindow?.webContents.send('wallet-changed', { label })
    }
    return { success: true }
  })

  ipcMain.handle('wallet:hasMnemonic', () => getWalletList().length > 0)
  ipcMain.handle('wallet:setup', async (_e, mnemonic: string, label?: string) => {
    const rpc = (store.get(STORE_KEY_RPC) as string | undefined) ?? DEFAULT_RPC
    return setupWallet(mnemonic, label || 'Default', rpc)
  })
  ipcMain.handle('wallet:loadStored', async () => {
    const wallets = getWalletList()
    if (!wallets.length) return { success: false, error: 'No stored wallets' }
    const idx = (store.get(STORE_KEY_ACTIVE_W) as number | undefined) ?? 0
    const w   = wallets[Math.min(idx, wallets.length - 1)]
    const mn  = decryptMnemonic(w.encrypted)
    if (!mn) return { success: false, error: 'Decrypt failed' }
    const rpc = (store.get(STORE_KEY_RPC) as string | undefined) ?? DEFAULT_RPC
    return setupWallet(mn, w.label, rpc)
  })
  ipcMain.handle('wallet:forget', () => {
    store.delete(STORE_KEY_WALLETS); store.delete(STORE_KEY_ACTIVE_W)
    walletState = { address: null, label: '', privkey: null, client: null, readonlyClient: null, rpc: DEFAULT_RPC }
    return { success: true }
  })

  ipcMain.handle('wallet:getBalances', async (_e, addresses: string[]) => {
    if (!walletState.readonlyClient) return { success: false, error: 'No RPC client' }
    try {
      const results = await Promise.all(addresses.map(async addr => {
        try {
          const balances = await walletState.readonlyClient!.getAllBalances(addr)
          return { address: addr, balances: balances.map(b => ({ denom: b.denom, amount: b.amount })) }
        } catch { return { address: addr, balances: [] } }
      }))
      return { success: true, results }
    } catch (err: unknown) { return { success: false, error: String(err) } }
  })

  ipcMain.handle('wallet:getInfo', async () => {
    if (!walletState.address || !walletState.readonlyClient) return { success: false, error: 'Wallet not initialized' }
    try {
      const [balances, sessResult] = await Promise.allSettled([
        walletState.readonlyClient.getAllBalances(walletState.address),
        walletState.readonlyClient.sentinelQuery?.session.sessionsForAccount(walletState.address, undefined)
      ])
      const rawSessions = sessResult.status === 'fulfilled' ? (sessResult.value?.sessions ?? []) : []
      const sessions = rawSessions.map(anyVal => {
        try {
          const decoded = Session.decode(anyVal.value)
          const bs = decoded.baseSession
          if (!bs) return null
          return { id: longToNum(bs.id), nodeAddress: bs.nodeAddress ?? '', status: bs.status ?? 0 }
        } catch { return null }
      }).filter(Boolean)
      return {
        success: true, address: walletState.address, label: walletState.label, rpc: walletState.rpc,
        balances: balances.status === 'fulfilled' ? balances.value.map(b => ({ denom: b.denom, amount: b.amount })) : [],
        sessions
      }
    } catch (err: unknown) { return { success: false, error: String(err) } }
  })

  ipcMain.handle('bookmark:list', () => (store.get('bookmarks') as string[] | undefined) ?? [])
  ipcMain.handle('bookmark:toggle', (_e, address: string) => {
    const bms = (store.get('bookmarks') as string[] | undefined) ?? []
    const idx = bms.indexOf(address)
    if (idx === -1) bms.push(address)
    else bms.splice(idx, 1)
    store.set('bookmarks', bms)
    return { bookmarks: bms }
  })

  ipcMain.handle('nodes:fetch', async () => {
    try {
      const res  = await fetch(NODES_API); const json = await res.json() as { data?: unknown[] }
      return { success: true, nodes: json.data ?? [] }
    } catch (err: unknown) { return { success: false, error: String(err), nodes: [] } }
  })

  ipcMain.handle('node:info', async (_e, remoteAddr: string) => {
    try {
      const info = await withTimeout(nodeInfo(remoteAddr), 8000, 'Node info timeout')
      return { success: true, info }
    } catch (err: unknown) { return { success: false, error: String(err) } }
  })

  ipcMain.handle('sessions:fetch', async () => {
    if (!walletState.readonlyClient || !walletState.address) return { success: false, sessions: [] }
    try {
      const r = await walletState.readonlyClient.sentinelQuery?.session.sessionsForAccount(walletState.address, undefined)
      const sessions = (r?.sessions ?? []).map(anyVal => {
        try {
          const decoded = Session.decode(anyVal.value); const bs = decoded.baseSession
          if (!bs) return null
          return {
            id: longToNum(bs.id), accAddress: bs.accAddress ?? '', nodeAddress: bs.nodeAddress ?? '',
            downloadBytes: bs.downloadBytes ?? '0', uploadBytes: bs.uploadBytes ?? '0', maxBytes: bs.maxBytes ?? '0',
            status: bs.status ?? 0, inactiveAt: bs.inactiveAt?.toISOString() ?? null, startAt: bs.startAt?.toISOString() ?? null,
            durationSecs: bs.duration ? longToNum(bs.duration.seconds) : 0,
            maxDurationSecs: bs.maxDuration ? longToNum(bs.maxDuration.seconds) : 0,
            price: decoded.price
              ? { denom: decoded.price.denom, baseValue: decoded.price.baseValue, quoteValue: decoded.price.quoteValue }
              : null,
          }
        } catch { return null }
      }).filter(Boolean)
      return { success: true, sessions }
    } catch (err: unknown) { return { success: false, error: String(err), sessions: [] } }
  })

  ipcMain.handle('session:cancel', async (_e, sessionId: number) => {
    if (!walletState.client || !walletState.address) return { success: false, error: 'Wallet not initialized' }
    try {
      const msg = sessionCancel({ from: walletState.address, id: Long.fromNumber(sessionId, true) })
      const tx  = await walletState.client.signAndBroadcast(walletState.address, [msg], 'auto', 'sentinel-dvpn-client')
      assertIsDeliverTxSuccess(tx); return { success: true }
    } catch (err: unknown) { return { success: false, error: String(err) } }
  })

  ipcMain.handle('traffic:start', () => {
    startTrafficPolling(); return { success: true }
  })
  ipcMain.handle('traffic:stop', () => {
    if (trafficInterval) { clearInterval(trafficInterval); trafficInterval = null }; return { success: true }
  })

  ipcMain.on('vpn:dns-retry-approved', () => { /* Logic handled via promise in wgQuickUp */ })

  ipcMain.handle('node:connect', async (_e, args: { nodeAddress: string; subscriptionType: 'gigabytes' | 'hours'; amount: number }) => {
    if (!walletState.client || !walletState.address || !walletState.privkey) return { success: false, error: 'Wallet not initialized' }
    lastConnectArgs = args; reconnectAttempts = 0; wasConnected = false; return doConnect(args)
  })

  ipcMain.handle('node:connectSession', async (_e, args: { nodeAddress: string; sessionId: number }) => {
    if (!walletState.client || !walletState.address || !walletState.privkey) return { success: false, error: 'Wallet not initialized' }
    activeSessionId = args.sessionId.toString(); activeNodeAddress = args.nodeAddress; 
    reconnectAttempts = 0; wasConnected = false;
    return doHandshake(args.nodeAddress, Long.fromNumber(args.sessionId, true))
  })

  ipcMain.handle('node:connectWireguard', async () => {
    if (!activeWgConfigFile) return { success: false, error: 'No WireGuard config' }
    const res = await wgQuickUp(activeWgConfigFile)
    if (res.success) wasConnected = true
    return res
  })

  ipcMain.handle('node:connectV2ray', async (_e, { transparent }: { transparent?: boolean } = {}) => {
    if (!activeV2Ray) return { success: false, error: 'No V2Ray session' }
    try {
      const pid = activeV2Ray.connect()
      if (transparent) {
        const result = await setupTransparentV2Ray(activeV2Ray)
        if (!result.success) {
          activeV2Ray.disconnect()
          return result
        }
      }
      wasConnected = true
      startTrafficPolling()
      return { success: true, pid }
    } catch (err: unknown) { return { success: false, error: String(err) } }
  })

  ipcMain.handle('node:retryTunnel', async (_e, { transparent }: { transparent?: boolean } = {}) => {
    if (activeWgConfigFile) return wgQuickUp(activeWgConfigFile)
    if (activeV2Ray) {
      try { activeV2Ray.disconnect() } catch (_) {}
      try {
        const pid = activeV2Ray.connect()
        if (transparent) {
          const result = await setupTransparentV2Ray(activeV2Ray)
          if (!result.success) return result
        }
        wasConnected = true
        startTrafficPolling()
        return { success: true, pid }
      } catch (err: unknown) { return { success: false, error: String(err) } }
    }
    return { success: false, error: 'No active tunnel instance to retry.' }
  })

  ipcMain.handle('node:disconnect', async () => {
    await killActiveConnections(false)
    mainWindow?.webContents.send('vpn:disconnected', { reason: 'manual' })
    return { success: true }
  })

  ipcMain.handle('network:getPublicIp', async () => {
    const fetchIp = async () => {
      const res = await fetch('https://ipapi.co/json/', { 
        headers: { 'User-Agent': 'sentinel-dvpn-client' },
        signal: AbortSignal.timeout(5000) 
      })
      return await res.json() as any
    }

    console.log('[Main] Fetching public IP info...')
    // Retry logic for IP fetch during routing transitions
    for (let i = 0; i < 3; i++) {
      try {
        if (i > 0) await new Promise(r => setTimeout(r, 1500 * i))
        const data = await fetchIp()
        console.log('[Main] IP info fetched successfully:', data?.ip)
        return data
      } catch (err: unknown) {
        console.warn(`[Main] IP fetch attempt ${i+1} failed:`, String(err))
        if (i === 2) return { error: String(err) }
      }
    }
    return { error: 'Unknown error' }
  })

  ipcMain.handle('killswitch:enable', async () => {
    try {
      await applyKillSwitch(true)
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('killswitch:disable', async () => {
    try {
      await applyKillSwitch(false)
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('vpn:status', () => ({
    v2rayActive: !!activeV2Ray, 
    v2rayPid: activeV2Ray?.child?.pid,
    wgActive: !!activeWgConfigFile, 
    wgInterface: activeWgConfigFile ? path.basename(activeWgConfigFile, '.conf') : null,
    tunActive: !!activeTun2Socks,
    tunPid: activeTun2Socks?.pid,
    tunInterface: activeTunInterface,
    sessionId: activeSessionId, 
    nodeAddress: activeNodeAddress
  }))
}

function getNextTunInterface(): string {
  for (let i = 0; i < 10; i++) {
    const ifName = `sentinel-tun${i}`
    try {
      execSync(`ip link show ${ifName}`, { stdio: 'ignore' })
    } catch {
      return ifName
    }
  }
  return 'sentinel-tun9'
}

async function setupTransparentV2Ray(v2ray: V2Ray): Promise<{ success: boolean; error?: string }> {
  const plat = process.platform
  const socksPort = v2ray.config.inbounds.find((ib: any) => ib.protocol === 'socks')?.port
  if (!socksPort) return { success: false, error: 'V2Ray SOCKS5 port not found' }

  try {
    const serverAddr = v2ray.config.outbounds.find((ob: any) => ob.protocol === 'vmess' || ob.protocol === 'vless')?.settings?.vnext?.[0]?.address
    if (!serverAddr) return { success: false, error: 'V2Ray server address not found' }

    let serverIp = serverAddr
    if (/[a-zA-Z]/.test(serverAddr)) {
      try {
        const ips = await dns.promises.resolve4(serverAddr)
        if (ips && ips.length > 0) serverIp = ips[0]
      } catch (e) { console.error('DNS resolve failed', e) }
    }
    activeV2RayServerIp = serverIp

    if (plat === 'linux') {
      const gwInfo = execSync("ip route show default | grep -v sentinel | head -n1").toString().trim().split(' ')
      const gateway = gwInfo[2]; const iface = gwInfo[4]
      const tunName = getNextTunInterface()
      activeTunInterface = tunName
      
      const setupCmds = [
        `ip tuntap add dev ${tunName} mode tun`,
        `ip addr add 10.0.0.1/24 dev ${tunName}`,
        `ip link set dev ${tunName} up`,
        `ip route add ${serverIp} via ${gateway} dev ${iface}`,
        `ip route add 0.0.0.0/1 dev ${tunName}`,
        `ip route add 128.0.0.0/1 dev ${tunName}`
      ]

      try {
        execPrivileged(setupCmds)
        const bin = findPrivEscBin()
        activeTun2Socks = spawn(bin === 'osascript' ? 'sudo' : bin, ['tun2socks', '-device', tunName, '-proxy', `socks5://127.0.0.1:${socksPort}`])
      } catch (e: any) {
        throw new Error(`System commands failed: ${e.message}`)
      }
      const settings = getSettings()
      if (settings.killSwitch) applyKillSwitch(true, tunName).catch(() => {})
    } else if (plat === 'darwin') {
      const gateway = execSync("netstat -rn | grep 'default' | head -n1 | awk '{print $2}'").toString().trim()
      activeTunInterface = 'utun10'
      const setupCmds = [
        `route add ${serverIp} ${gateway}`,
        `ifconfig ${activeTunInterface} 10.0.0.1 10.0.0.2 up`,
        `route add -net 0.0.0.0/1 -interface ${activeTunInterface}`,
        `route add -net 128.0.0.0/1 -interface ${activeTunInterface}`
      ]
      try {
        execPrivileged(setupCmds)
        // Spawn tun2socks using sudo (osascript is only for shell strings, not for persistent spawns)
        // Since we just ran execPrivileged, the credentials might be cached in sudo
        activeTun2Socks = spawn('sudo', ['tun2socks', '-device', activeTunInterface, '-proxy', `socks5://127.0.0.1:${socksPort}`])
      } catch (e: any) {
        throw new Error(`macOS setup failed: ${e.message}`)
      }
      const settings = getSettings()
      if (settings.killSwitch) applyKillSwitch(true, activeTunInterface).catch(() => {})
    } else if (plat === 'win32') {
      activeTunInterface = 'sentinel-tun'
      execSync(`route add ${serverIp} mask 255.255.255.255 0.0.0.0 METRIC 1`, { stdio: 'ignore' })
      activeTun2Socks = spawn('tun2socks.exe', ['-device', activeTunInterface, '-proxy', `socks5://127.0.0.1:${socksPort}`])
      await new Promise(r => setTimeout(r, 1000))
      execSync(`netsh interface ipv4 set address name="${activeTunInterface}" source=static addr=10.0.0.1 mask=255.255.255.0 gateway=none`, { stdio: 'ignore' })
      execSync(`route add 0.0.0.0 mask 128.0.0.0 10.0.0.1 METRIC 5`, { stdio: 'ignore' })
      execSync(`route add 128.0.0.0 mask 128.0.0.0 10.0.0.1 METRIC 5`, { stdio: 'ignore' })
      const settings = getSettings()
      if (settings.killSwitch) applyKillSwitch(true, activeTunInterface).catch(() => {})
    }
    return { success: true }
  } catch (err: any) { return { success: false, error: `Transparent setup failed: ${err.message}` } }
}

function extractError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as any
    if (e.response) {
      const status = e.response.status; const data = e.response.data
      if (data) {
        if (data.error && typeof data.error === 'object' && data.error.message) return `[${status}] ${data.error.message}`
        const msg = data.message || data.error || data.detail
        if (msg && typeof msg === 'string') return `[${status}] ${msg}`
        if (typeof data === 'object') return `[${status}] ${JSON.stringify(data)}`
        return `[${status}] ${String(data)}`
      }
      return `[${status}] ${e.message || 'No response body'}`
    }
    if (e.rawLog) return e.rawLog
    if (e.message) return e.message
  }
  return String(err)
}

async function doConnect(args: { nodeAddress: string; subscriptionType: 'gigabytes' | 'hours'; amount: number }) {
  try {
    mainWindow?.webContents.send('vpn:status', { step: 'fetching_node' })
    const chainNode = await withTimeout(walletState.client!.sentinelQuery?.node.node(args.nodeAddress), RPC_TIMEOUT_MS, 'RPC timeout fetching node')
    if (!chainNode) return { success: false, error: `Node not found: ${args.nodeAddress}` }
    const remoteAddr = chainNode.remoteAddrs?.[0]
    if (!remoteAddr) return { success: false, error: 'Node has no remote addresses' }
    const chainPrices = (args.subscriptionType === 'gigabytes' ? chainNode.gigabytePrices : chainNode.hourlyPrices) ?? []
    const udvpnPrice = chainPrices.find((p: Price) => p.denom === 'udvpn')
    if (!udvpnPrice) return { success: false, error: `No udvpn price on chain` }

    mainWindow?.webContents.send('vpn:status', { step: 'preparing_tx' })
    const txArgs: TxNodeStartSession = {
      from: walletState.address!, nodeAddress: args.nodeAddress,
      gigabytes: args.subscriptionType === 'gigabytes' ? Long.fromNumber(Math.max(1, args.amount), true) : undefined,
      hours: args.subscriptionType === 'hours' ? Long.fromNumber(Math.max(1, args.amount), true) : undefined,
      maxPrice: udvpnPrice, fee: 'auto', memo: 'sentinel-dvpn-client'
    }
    mainWindow?.webContents.send('vpn:status', { step: 'signing_tx' })
    mainWindow?.webContents.send('vpn:status', { step: 'broadcasting_tx' })
    const tx = await walletState.client!.signAndBroadcast(walletState.address!, [nodeStartSession(txArgs)], 'auto', 'sentinel-dvpn-client')
    assertIsDeliverTxSuccess(tx)

    mainWindow?.webContents.send('vpn:status', { step: 'extracting_tx' })
    const event = searchEvent(NodeEventCreateSession.type, tx.events)
    if (!event) return { success: false, error: 'Session creation event not found' }
    const parsed = NodeEventCreateSession.parse(event); const sessionId = parsed.value.sessionId
    activeSessionId = sessionId.toString(); activeNodeAddress = args.nodeAddress
    return doHandshake(args.nodeAddress, sessionId)
  } catch (err: unknown) { return { success: false, error: extractError(err) } }
}

function getNextWgInterface(): string {
  for (let i = 0; i < 10; i++) {
    const ifName = `sentinel${i}`
    try { execSync(`ip link show ${ifName}`, { stdio: 'ignore' }) } catch { return ifName }
  }
  return 'sentinel9'
}

async function doHandshake(nodeAddress: string, sessionId: Long) {
  try {
    activeSessionId = sessionId.toString(); activeNodeAddress = nodeAddress
    mainWindow?.webContents.send('vpn:status', { status: 'node_handshake', step: 'handshaking', sessionId: activeSessionId })
    const chainNode = await withTimeout(walletState.client!.sentinelQuery?.node.node(nodeAddress), RPC_TIMEOUT_MS, 'RPC timeout fetching node')
    if (!chainNode) return { success: false, error: `Node not found: ${nodeAddress}` }
    const remoteAddr = chainNode.remoteAddrs?.[0]
    if (!remoteAddr) return { success: false, error: 'Node has no remote addresses' }

    mainWindow?.webContents.send('vpn:status', { step: 'fetching_node_info' })
    const nInfo = await nodeInfo(remoteAddr).catch(e => { throw new Error(`[nodeInfo] ${extractError(e)}`) })
    const settings = getSettings()

    if (nInfo.service_type === NodeVPNType.WIREGUARD) {
      mainWindow?.webContents.send('vpn:status', { step: 'generating_config' })
      if (activeWgConfigFile) { try { await wgQuickDown(activeWgConfigFile) } catch (_) {}; activeWgConfigFile = null }
      const wg = new Wireguard(); const result = await handshake(sessionId, { public_key: wg.publicKey }, walletState.privkey!, remoteAddr).catch(e => { throw new Error(`[handshake] ${extractError(e)}`) })
      const hd = JSON.parse(Buffer.from(result.data, 'base64').toString('utf8'))
      const dns = settings.dohIp ? [settings.dohIp] : undefined
      await wg.parseConfig(hd, result.addrs, dns)
      let configStr = wg.buildConfigString()
      if (!configStr) return { success: false, error: 'WireGuard: config null' }
      if (settings.splitTunnel && settings.splitRoutes) configStr = configStr.replace(/AllowedIPs\s*=\s*.+/g, `AllowedIPs = ${settings.splitRoutes}`)
      const qrCode = await QRCode.toDataURL(configStr, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
      const ifName = getNextWgInterface(); const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sentinel-${ifName}-`))
      activeWgConfigFile = path.join(tmpDir, `${ifName}.conf`); fs.writeFileSync(activeWgConfigFile, configStr, { mode: 0o600 }); activeWgInstance = wg
      return { success: true, vpnType: 'wireguard', sessionId: activeSessionId, configStr, qrCode }
    }

    if (nInfo.service_type === NodeVPNType.V2RAY) {
      if (activeV2Ray) { try { activeV2Ray.disconnect() } catch (_) {}; activeV2Ray = null }
      const v2ray = new V2Ray(); const result = await handshake(sessionId, { uuid: v2ray.getKey() }, walletState.privkey!, remoteAddr).catch(e => { throw new Error(`[handshake] ${extractError(e)}`) })
      const hd = JSON.parse(Buffer.from(result.data, 'base64').toString('utf8')); await v2ray.parseConfig(hd, result.addrs)
      const shareLinks = v2ray.buildShareLinks(`sentinel-${nodeAddress.slice(-8)}`)
      const qrCodes = await Promise.all(shareLinks.map(link => QRCode.toDataURL(link, { width: 280, margin: 1, color: { dark: '#34d399', light: '#060810' } })))
      const inbounds = (v2ray.config?.inbounds ?? []).filter((ib: any) => ib.protocol !== 'dokodemo-door').map((ib: any) => ({ protocol: ib.protocol, listen: ib.listen, port: ib.port }))
      activeV2Ray = v2ray; return { success: true, vpnType: 'v2ray', sessionId: activeSessionId, shareLinks, qrCodes, inbounds }
    }
    return { success: false, error: `Unknown VPN type: ${nInfo.service_type}` }
  } catch (err: unknown) {
    if (activeWgConfigFile) { try { fs.rmSync(path.dirname(activeWgConfigFile), { recursive: true, force: true }) } catch (_) {}; activeWgConfigFile = null; activeWgInstance = null }
    return { success: false, error: extractError(err) }
  }
}

async function getTrafficStats(): Promise<{ rx: number; tx: number; source: string }> {
  // 1. WireGuard Stats
  if (activeWgConfigFile && activeWgInstance) {
    const ifName = path.basename(activeWgConfigFile, '.conf')
    if (process.platform === 'linux') {
      try {
        const rx = parseInt(fs.readFileSync(`/sys/class/net/${ifName}/statistics/rx_bytes`, 'utf8').trim()) || 0
        const tx = parseInt(fs.readFileSync(`/sys/class/net/${ifName}/statistics/tx_bytes`, 'utf8').trim()) || 0
        return { rx, tx, source: 'wireguard' }
      } catch { /* Fallback */ }
    }
    try {
      const lines = execSync('wg show all transfer', { stdio: 'pipe' }).toString().trim().split('\n')
      let rx = 0, tx = 0; for (const line of lines) { const parts = line.trim().split(/\s+/); if (parts.length >= 3) { rx += parseInt(parts[1]) || 0; tx += parseInt(parts[2]) || 0 } }
      return { rx, tx, source: 'wireguard' }
    } catch { }
  }

  // 2. tun2socks Stats (Linux TUN fallback)
  if (activeTunInterface && process.platform === 'linux') {
    try {
      const rx = parseInt(fs.readFileSync(`/sys/class/net/${activeTunInterface}/statistics/rx_bytes`, 'utf8').trim()) || 0
      const tx = parseInt(fs.readFileSync(`/sys/class/net/${activeTunInterface}/statistics/tx_bytes`, 'utf8').trim()) || 0
      if (rx > 0 || tx > 0) return { rx, tx, source: 'tun2socks' }
    } catch { }
  }

  // 3. V2Ray API Stats
  if (activeV2Ray?.config?.inbounds) {
    try {
      const apiInbound = activeV2Ray.config.inbounds.find((ib: any) => ib.tag === 'api')
      if (apiInbound) {
        const res = await fetch(`http://127.0.0.1:${apiInbound.port}/stats/query`, { signal: AbortSignal.timeout(1000) }).catch(() => null)
        if (res?.ok) {
          const data = await res.json() as any; const vals = (data.stat ?? []).map((s: any) => parseInt(s.value) || 0)
          return { rx: vals.filter((_: any, i: number) => i % 2 === 0).reduce((a: any, b: any) => a + b, 0), tx: vals.filter((_: any, i: number) => i % 2 === 1).reduce((a: any, b: any) => a + b, 0), source: 'v2ray' }
        }
      }
    } catch { }
  }
  return { rx: 0, tx: 0, source: 'none' }
}

function startTrafficPolling() {
  if (trafficInterval) clearInterval(trafficInterval)
  trafficInterval = setInterval(async () => { const stats = await getTrafficStats(); mainWindow?.webContents.send('traffic:update', stats) }, 2000)
}

async function applyKillSwitch(enable: boolean, ifNameOverride?: string): Promise<void> {
  let ifName = ifNameOverride
  if (!ifName) {
    if (activeWgConfigFile) ifName = path.basename(activeWgConfigFile, '.conf')
    else if (activeTunInterface) ifName = activeTunInterface
  }
  if (!ifName && enable) {
    console.warn('[KillSwitch] No active interface to protect. Skipping apply.')
    return
  }

  const plat = process.platform
  if (plat === 'linux') {
    const targetIf = ifName || 'sentinel+'
    const cmds = enable 
      ? [`iptables -I OUTPUT ! -o ${targetIf} -m mark ! --mark 0xca6c -j DROP`, `iptables -I OUTPUT -o lo -j ACCEPT`, `ip6tables -I OUTPUT ! -o ${targetIf} -j DROP`, `ip6tables -I OUTPUT -o lo -j ACCEPT`] 
      : [`iptables -D OUTPUT ! -o ${targetIf} -m mark ! --mark 0xca6c -j DROP || true`, `iptables -D OUTPUT -o lo -j ACCEPT || true`, `ip6tables -D OUTPUT ! -o ${targetIf} -j DROP || true`, `ip6tables -D OUTPUT -o lo -j ACCEPT || true`]
    
    const res = execPrivileged(cmds)
    if (res.code !== 0 && enable) console.warn(`[KillSwitch] Linux apply failed: ${res.stderr}`)
  } else if (plat === 'darwin') {
    const rules = enable ? `block drop all\npass on lo0\npass on utun+\n` : `pass all\n`
    fs.writeFileSync('/tmp/sentinel-pf.conf', rules)
    const res = execPrivileged([`pfctl -f /tmp/sentinel-pf.conf ${enable ? '-e' : '-d'} || true`])
    if (res.code !== 0 && enable) console.warn(`[KillSwitch] PF failed: ${res.stderr}`)
  } else if (plat === 'win32') {
    try {
      if (enable) {
        // Add rules (KillSwitch: block all, but allow VPN traffic)
        execSync('netsh advfirewall firewall add rule name="SentinelKS" dir=out action=block & netsh advfirewall firewall add rule name="SentinelKS-VPN" dir=out action=allow interface=any', { stdio: 'ignore' })
      } else {
        // Delete rules silently
        execSync('netsh advfirewall firewall delete rule name="SentinelKS" & netsh advfirewall firewall delete rule name="SentinelKS-VPN" & exit 0', { stdio: 'ignore' })
      }
    } catch (e) { console.warn(`[KillSwitch] Windows Firewall failed`, e) }
  }
}

function execPrivileged(cmds: string[]): { code: number; stdout: string; stderr: string } {
  const plat = process.platform
  const fullCmd = cmds.join(' && ')
  console.log(`[ExecPrivileged] Platform: ${plat}, Command: ${fullCmd}`)

  try {
    if (plat === 'darwin') {
      const osaCmd = `osascript -e 'do shell script "${fullCmd.replace(/"/g, '\\"')}" with administrator privileges'`
      const stdout = execSync(osaCmd).toString()
      return { code: 0, stdout, stderr: '' }
    } else if (plat === 'win32') {
      const stdout = execSync(fullCmd).toString()
      return { code: 0, stdout, stderr: '' }
    } else {
      const bin = ['pkexec', 'gksudo', 'kdesudo', 'sudo'].find(b => {
        try { execSync(`which ${b}`, { stdio: 'ignore' }); return true } catch { return false }
      }) || 'sudo'
      const cmdPrefix = bin === 'sudo' ? 'sudo -A' : bin
      const stdout = execSync(`${cmdPrefix} bash -c "${fullCmd.replace(/"/g, '\\"')}"`).toString()
      return { code: 0, stdout, stderr: '' }
    }
  } catch (e: any) {
    return { 
      code: e.status ?? 1, 
      stdout: e.stdout?.toString() ?? '', 
      stderr: e.stderr?.toString() ?? e.message 
    }
  }
}

function findPrivEscBin(): string {
  if (process.platform === 'darwin') return 'osascript'
  for (const bin of ['pkexec', 'gksudo', 'kdesudo', 'sudo']) { try { execSync(`which ${bin}`, { stdio: 'ignore' }); return bin } catch (_) {} }
  return 'sudo'
}

function patchConfigFileForDns(configFile: string): void {
  try {
    const raw = fs.readFileSync(configFile, 'utf8'); const patched = raw.replace(/^DNS\s*=.*$/gm, '# DNS= stripped'); if (patched !== raw) { fs.writeFileSync(configFile, patched, { mode: 0o600 }) }
  } catch (_) {}
}

async function wgQuickUp(configFile: string): Promise<{ success: boolean; error?: string }> {
  const plat = process.platform
  const isDnsError = (stderr: string) => 
    stderr.includes('resolvconf') || stderr.includes('resolve1') || stderr.includes('Failed to set DNS') || stderr.includes('DNS')

  const run = () => {
    if (plat === 'win32') {
      const info = checkBinaries()
      const exe = info.wgPath || 'wireguard.exe'
      return { code: execPrivileged([`"${exe}" /installtunnelservice "${configFile}"`]).code, stderr: '' }
    }
    return execPrivileged([`wg-quick up "${configFile}"`])
  }

  let r1 = run()
  if (r1.code === 0) {
    const settings = getSettings()
    if (settings.killSwitch) applyKillSwitch(true).catch(() => {})
    startTrafficPolling()
    return { success: true }
  }

  if (isDnsError(r1.stderr)) {
    mainWindow?.webContents.send('vpn:dns-retry-ask')
    await new Promise((res) => { ipcMain.once('vpn:dns-retry-approved', () => res(true)) })
    patchConfigFileForDns(configFile)
    let r2 = run()
    if (r2.code === 0) {
      startTrafficPolling()
      mainWindow?.webContents.send('vpn:warning', { message: 'Connected without DNS injection.' })
      return { success: true }
    }
    return { success: false, error: r2.stderr }
  }
  return { success: false, error: r1.stderr }
}

async function wgQuickDown(configFile: string): Promise<void> {
  const plat = process.platform
  const ifName = path.basename(configFile, '.conf')

  try {
    if (plat === 'win32') {
      const info = checkBinaries()
      const exe = info.wgPath || 'wireguard.exe'
      spawnSync(exe, ['/uninstalltunnelservice', ifName], { stdio: 'ignore' })
    } else {
      try { execSync(`ip link show ${ifName}`, { stdio: 'ignore' }) } catch { return }
      execPrivileged([`wg-quick down "${configFile}"`])
    }
  } catch (e) { console.warn('wgQuickDown failed', e) }

  try { fs.rmSync(path.dirname(configFile), { recursive: true, force: true }) } catch (_) {}
}

function scheduleReconnect() {
  const settings = getSettings(); if (!settings.autoReconnect || !lastConnectArgs || !wasConnected) return
  if (reconnectAttempts >= 5) { mainWindow?.webContents.send('vpn:reconnect', { status: 'failed' }); return }
  const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60_000); reconnectAttempts++
  mainWindow?.webContents.send('vpn:reconnect', { status: 'waiting', attempt: reconnectAttempts, delay })
  reconnectTimer = setTimeout(async () => {
    mainWindow?.webContents.send('vpn:reconnect', { status: 'reconnecting' });
    let result: any
    if (activeSessionId && activeNodeAddress) {
      result = await doHandshake(activeNodeAddress, Long.fromString(activeSessionId, true))
    } else {
      result = await doConnect(lastConnectArgs!)
    }
    if (result.success) { reconnectAttempts = 0; mainWindow?.webContents.send('vpn:reconnect', { status: 'connected' }) } else { scheduleReconnect() }
  }, delay)
}

function getSettings(): AppSettings { return { ...DEFAULT_SETTINGS, ...((store.get(STORE_KEY_SETTINGS) as Partial<AppSettings>) ?? {}) } }
function longToNum(v: any): number { if (v == null) return 0; if (typeof v === 'number') return v; if (typeof v === 'string') return parseInt(v, 10) || 0; return v.toNumber ? v.toNumber() : 0 }
function getWalletList(): Array<{ label: string; encrypted: string }> { return (store.get(STORE_KEY_WALLETS) as any) ?? [] }
function encryptMnemonic(mnemonic: string): string | null { 
  if (!safeStorage.isEncryptionAvailable()) {
    console.error('CRITICAL: safeStorage is NOT available. Insecure fallback blocked.')
    return null
  }
  return safeStorage.encryptString(mnemonic).toString('base64')
}
function decryptMnemonic(encrypted: string): string | null { 
  try { 
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64')) 
  } catch { return null } 
}
function getActiveMnemonic(): string | null { const wallets = getWalletList(); if (!wallets.length) return null; const idx = (store.get(STORE_KEY_ACTIVE_W) as number) ?? 0; return decryptMnemonic(wallets[Math.min(idx, wallets.length - 1)].encrypted) }

async function setupWallet(mnemonic: string, label: string, rpc: string) {
  try {
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic.trim(), { prefix: 'sent' })
    const [acct] = await wallet.getAccounts(); const privkey = await privKeyFromMnemonic({ mnemonic: wallet.mnemonic })
    const client = await withTimeout(SigningSentinelClient.connectWithSigner(rpc, wallet, { gasPrice: makeGasPrice('0.2udvpn') as any }), RPC_TIMEOUT_MS, 'RPC timeout')
    const readonlyClient = await withTimeout(SentinelClient.connect(rpc), RPC_TIMEOUT_MS, 'RPC timeout')
    walletState = { address: acct.address, label, privkey, client, readonlyClient, rpc }
    
    // Notify UI immediately
    mainWindow?.webContents.send('wallet-changed', { address: acct.address, label })
    
    return { success: true, address: acct.address, label, rpc }
  } catch (err: unknown) { return { success: false, error: String(err) } }
}

function withTimeout<T>(promise: Promise<T> | undefined, ms: number, msg: string): Promise<T> { if (!promise) return Promise.reject(new Error(msg)); return Promise.race([promise, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]) }

function checkBinaries() {
  const getHash = (p: string) => { try { const data = fs.readFileSync(p); return crypto.createHash('sha256').update(data).digest('hex') } catch { return null } }
  const find = (n: string) => { 
    try { 
      const cmd = process.platform === 'win32' ? `where ${n}` : `which ${n}`; 
      return execSync(cmd, { stdio: 'pipe' }).toString().trim().split('\n')[0] 
    } catch { 
      if (process.platform === 'win32' && n === 'wireguard.exe') {
        const standardPath = 'C:\\Program Files\\WireGuard\\wireguard.exe'
        if (fs.existsSync(standardPath)) return standardPath
      }
      return null 
    } 
  }
  const getDistro = () => { if (process.platform !== 'linux') return process.platform; try { const content = fs.readFileSync('/etc/os-release', 'utf8').toLowerCase(); if (content.includes('id=arch') || content.includes('id_like=arch')) return 'arch'; if (content.includes('id=ubuntu') || content.includes('id=debian') || content.includes('id_like=debian')) return 'debian'; if (content.includes('id=fedora') || content.includes('id=rhel') || content.includes('id_like=fedora')) return 'fedora'; if (content.includes('id=suse') || content.includes('id_like=suse')) return 'suse' } catch { } return 'linux' }
  const wgName = process.platform === 'win32' ? 'wireguard.exe' : 'wg-quick'; const v2Path = find('v2ray'); const wgPath = find(wgName); const t2sPath = find('tun2socks')
  return { wireguard: !!wgPath, wgPath, wgHash: wgPath ? getHash(wgPath) : null, v2ray: !!v2Path, v2rayPath: v2Path, v2rayHash: v2Path ? getHash(v2Path) : null, tun2socks: !!t2sPath, tun2socksPath: t2sPath, tun2socksHash: t2sPath ? getHash(t2sPath) : null, platform: process.platform, distro: getDistro() }
}

async function killActiveConnections(sendEndSession = true) {
  if (trafficInterval) { clearInterval(trafficInterval); trafficInterval = null }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  
  // Disable Kill Switch immediately to restore local connectivity during teardown
  try { await applyKillSwitch(false) } catch (e) { console.warn('[Teardown] Failed to disable Kill Switch', e) }

  if (sendEndSession && activeSessionId && walletState.client && walletState.address) {
    try { await walletState.client.signAndBroadcast(walletState.address, [sessionCancel({ from: walletState.address, id: Long.fromString(activeSessionId, true) })], 'auto', 'sentinel-dvpn-client') } catch { }
  }
  if (activeTun2Socks) {
    const plat = process.platform
    if (plat === 'linux' && activeTunInterface) {
      const cleanupCmds = [
        `kill ${activeTun2Socks.pid} || true`, 
        `ip route del 0.0.0.0/1 dev ${activeTunInterface} || true`, 
        `ip route del 128.0.0.0/1 dev ${activeTunInterface} || true`, 
        activeV2RayServerIp ? `ip route del ${activeV2RayServerIp} || true` : `true`, 
        `ip link set dev ${activeTunInterface} down || true`, 
        `ip tuntap del dev ${activeTunInterface} mode tun || true`
      ]
      try { execPrivileged(cleanupCmds) } catch (e) { console.warn('Linux cleanup failed', e) }
    } else if (plat === 'darwin' && activeTunInterface) {
      const cleanupCmds = [
        `kill ${activeTun2Socks.pid} || true`,
        `route delete 0.0.0.0/1 || true`,
        `route delete 128.0.0.0/1 || true`,
        activeV2RayServerIp ? `route delete ${activeV2RayServerIp} || true` : `true`
      ]
      try { execPrivileged(cleanupCmds) } catch (e) { console.warn('macOS cleanup failed', e) }
    } else if (plat === 'win32') {
      try { 
        activeTun2Socks.kill()
        execSync(`route delete 0.0.0.0 mask 128.0.0.0`, { stdio: 'ignore' })
        execSync(`route delete 128.0.0.0 mask 128.0.0.0`, { stdio: 'ignore' })
        if (activeV2RayServerIp) execSync(`route delete ${activeV2RayServerIp}`, { stdio: 'ignore' })
      } catch (e) { console.warn('Windows cleanup failed', e) }
    } else { activeTun2Socks.kill() }
    activeTun2Socks = null; activeTunInterface = null; activeV2RayServerIp = null
  }
  if (activeV2Ray) { try { activeV2Ray.disconnect() } catch { }; activeV2Ray = null }
  if (activeWgConfigFile) { await wgQuickDown(activeWgConfigFile); activeWgConfigFile = null; activeWgInstance = null }
  activeSessionId = null; activeNodeAddress = null; lastConnectArgs = null
}

const _origConnect = V2Ray.prototype.connect
V2Ray.prototype.connect = function (configFile?: string) {
  const pid = _origConnect.call(this, configFile) as number | undefined
  if (this.child) { (this.child as ChildProcess).on('exit', () => { if (activeV2Ray === this) { mainWindow?.webContents.send('vpn:disconnected', { reason: 'V2Ray exited' }); activeV2Ray = null; scheduleReconnect() } }) }
  return pid
}

import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow:    () => ipcRenderer.invoke('window:close'),
  quitApp:        (endSession: boolean) => ipcRenderer.invoke('app:quit', endSession),

  getRpcList:    () => ipcRenderer.invoke('rpc:list'),
  getCurrentRpc: () => ipcRenderer.invoke('rpc:get'),
  setRpc:        (url: string) => ipcRenderer.invoke('rpc:set', url),

  getSettings:   () => ipcRenderer.invoke('settings:get'),
  saveSettings:  (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:set', patch),

  checkBinaries: () => ipcRenderer.invoke('binary:check'),
  installBinary: (cmd: string) => ipcRenderer.invoke('binary:install', cmd),

  // Multi-wallet
  listWallets:   () => ipcRenderer.invoke('wallet:list'),
  getBalances:   (addresses: string[]) => ipcRenderer.invoke('wallet:getBalances', addresses),
  addWallet:     (mnemonic: string, label: string) => ipcRenderer.invoke('wallet:add', mnemonic, label),
  switchWallet:  (index: number) => ipcRenderer.invoke('wallet:switch', index),
  removeWallet:  (index: number) => ipcRenderer.invoke('wallet:remove', index),
  renameWallet:  (index: number, label: string) => ipcRenderer.invoke('wallet:rename', index, label),
  hasMnemonic:      () => ipcRenderer.invoke('wallet:hasMnemonic'),
  setupWallet:      (mnemonic: string, label?: string) => ipcRenderer.invoke('wallet:setup', mnemonic, label),
  loadStoredWallet: () => ipcRenderer.invoke('wallet:loadStored'),
  forgetWallet:     () => ipcRenderer.invoke('wallet:forget'),
  getWalletInfo:    () => ipcRenderer.invoke('wallet:getInfo'),

  // Bookmarks
  listBookmarks:  () => ipcRenderer.invoke('bookmark:list'),
  toggleBookmark: (address: string) => ipcRenderer.invoke('bookmark:toggle', address),

  // Nodes
  fetchNodes:     () => ipcRenderer.invoke('nodes:fetch'),
  fetchNodeInfo:  (remoteAddr: string) => ipcRenderer.invoke('node:info', remoteAddr),

  // Sessions
  fetchSessions:  () => ipcRenderer.invoke('sessions:fetch'),
  cancelSession:  (id: number) => ipcRenderer.invoke('session:cancel', id),

  // Traffic
  startTraffic:   () => ipcRenderer.invoke('traffic:start'),
  stopTraffic:    () => ipcRenderer.invoke('traffic:stop'),

  // Kill switch
  enableKillSwitch:  () => ipcRenderer.invoke('killswitch:enable'),
  disableKillSwitch: () => ipcRenderer.invoke('killswitch:disable'),

  // VPN
  connectNode: (args: { nodeAddress: string; subscriptionType: 'gigabytes' | 'hours'; amount: number }) =>
    ipcRenderer.invoke('node:connect', args),
  connectSession: (args: { nodeAddress: string; sessionId: number }) =>
    ipcRenderer.invoke('node:connectSession', args),
  connectWireGuard: () => ipcRenderer.invoke('node:connectWireguard'),
  connectV2Ray:     (args: { transparent?: boolean } = {}) => ipcRenderer.invoke('node:connectV2ray', args),
  retryTunnel:      (args: { transparent?: boolean } = {}) => ipcRenderer.invoke('node:retryTunnel', args),
  disconnectNode:   () => ipcRenderer.invoke('node:disconnect'),
  getVpnStatus:     () => ipcRenderer.invoke('vpn:status'),
  getPublicIp:      () => ipcRenderer.invoke('network:getPublicIp'),

  // Events → renderer
  onVpnStatus:      (cb: (d: unknown) => void) => { 
    const l = (_: any, d: any) => cb(d)
    ipcRenderer.on('vpn:status', l)
    return () => ipcRenderer.removeListener('vpn:status', l) 
  },
  onTrafficUpdate:  (cb: (d: unknown) => void) => { 
    const l = (_: any, d: any) => cb(d)
    ipcRenderer.on('traffic:update', l)
    return () => ipcRenderer.removeListener('traffic:update', l) 
  },
  onVpnDisconnect:  (cb: (d: unknown) => void) => { 
    const l = (_: any, d: any) => cb(d)
    ipcRenderer.on('vpn:disconnected', l)
    return () => ipcRenderer.removeListener('vpn:disconnected', l) 
  },
  onReconnect:      (cb: (d: unknown) => void) => { 
    const l = (_: any, d: any) => cb(d)
    ipcRenderer.on('vpn:reconnect', l)
    return () => ipcRenderer.removeListener('vpn:reconnect', l) 
  },
  onVpnWarning:     (cb: (d: unknown) => void) => { 
    const l = (_: any, d: any) => cb(d)
    ipcRenderer.on('vpn:warning', l)
    return () => ipcRenderer.removeListener('vpn:warning', l) 
  },
  onWalletChanged:  (cb: (d: any) => void) => { 
    const l = (_: any, d: any) => cb(d)
    ipcRenderer.on('wallet-changed', l)
    return () => ipcRenderer.removeListener('wallet-changed', l) 
  },
  onDnsRetryAsk:    (cb: () => void) => { 
    const l = () => cb()
    ipcRenderer.on('vpn:dns-retry-ask', l)
    return () => ipcRenderer.removeListener('vpn:dns-retry-ask', l) 
  },
  approveDnsRetry:  () => ipcRenderer.send('vpn:dns-retry-approved'),
  onCloseRequest:   (cb: () => void) => { 
    const l = () => cb()
    ipcRenderer.on('app:close-request', l)
    return () => ipcRenderer.removeListener('app:close-request', l) 
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (e) { console.error(e) }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}

export type API = typeof api

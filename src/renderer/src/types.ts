export interface NodePrice { denom: string; value: string }

export interface ApiNode {
  address: string; moniker: string; version: string; type: number
  api: string; asn: string | null; country: string; city: string
  isResidential: boolean; isActive: boolean; isHealthy: boolean
  isDuplicate: boolean; isWhitelisted: boolean
  gigabytePrices: NodePrice[]; hourlyPrices: NodePrice[]
  leases: number; sessions: number; peers: number
  errorMessage: string | null; fetchedAt: string
}

// Session decoded via Session.decode(any.value) in main, serialized to plain JS for IPC.
// Mirrors BaseSession from @sentinel-official/sentinel-js-sdk sentinel/session/v3/session
// wrapped in node/v3/session Session { baseSession, price }
export interface ChainSession {
  id:              number   // Long → number
  accAddress:      string
  nodeAddress:     string
  downloadBytes:   string   // bytes down this session
  uploadBytes:     string   // bytes up this session
  maxBytes:        string   // session quota
  status:          number   // 1=ACTIVE 2=INACTIVE_PENDING 3=INACTIVE
  inactiveAt:      string | null
  startAt:         string | null
  statusAt:        string | null
  durationSecs:    number
  maxDurationSecs: number
  price: { denom: string; baseValue: string; quoteValue: string } | null
  }


export interface WalletInfo {
  address: string; label: string; rpc: string
  balances: { denom: string; amount: string }[]
  balancesError: string | null
  sessions: ChainSession[]
  sessionsError: string | null
}

export interface WalletEntry { index: number; label: string; active: boolean; address?: string }

export interface RpcEndpoint { label: string; url: string; region: string }

export interface BinaryStatus {
  wireguard: boolean; wgPath: string | null; wgHash: string | null
  v2ray: boolean; v2rayPath: string | null; v2rayHash: string | null
  tun2socks: boolean; tun2socksPath: string | null; tun2socksHash: string | null
  platform: string; distro: string
}

export interface AppSettings {
  killSwitch: boolean; autoReconnect: boolean
  splitTunnel: boolean; splitRoutes: string
  dohIp: string | null
}

export interface TrafficStats { rx: number; tx: number; source: string }

export interface NodeFilters {
  search: string; country: string; city: string
  type: '' | '1' | '2'
  onlyActive: boolean; onlyHealthy: boolean; onlyWhitelisted: boolean
  hideResidential: boolean; hideDuplicate: boolean
  bookmarksOnly: boolean
}

export type SubscriptionType = 'gigabytes' | 'hours'

export type ConnectStep =
  | 'choose-type' | 'subscribing' | 'handshaking'
  | 'wg-options' | 'v2ray-options' | 'connecting' | 'connected' | 'error'
  | 'fetching_node' | 'preparing_tx' | 'signing_tx' | 'broadcasting_tx' | 'extracting_tx'
  | 'fetching_node_info' | 'generating_config' | 'wg_dns_retry'

export interface ConnectionState {
  step: ConnectStep; node: ApiNode | null
  subscriptionType: SubscriptionType; amount: number; sessionId: string | null
  vpnType: 'wireguard' | 'v2ray' | null
  configStr: string | null; wgQrCode: string | null
  shareLinks: string[]; v2rayQrCodes: string[]
  inbounds: Array<{ protocol: string; listen: string; port: number }> | null
  error: string | null
  isTransparent?: boolean
}

export const INITIAL_CONNECTION: ConnectionState = {
  step: 'choose-type', node: null, subscriptionType: 'gigabytes', amount: 1,
  sessionId: null, vpnType: null, configStr: null, wgQrCode: null,
  shareLinks: [], v2rayQrCodes: [], inbounds: null, error: null
}

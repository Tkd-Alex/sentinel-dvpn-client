import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiNode, ConnectionState, INITIAL_CONNECTION, SubscriptionType, BinaryStatus } from '../types'
import { countryToFlag, formatUdvpnPrice, vpnTypeLabel } from '../utils'
import TrafficStatsWidget from './TrafficStats'

// ── UsageProgress helper ──────────────────────────────────────────────────
function UsageProgress({ session }: { session: any }) {
  const { t } = useTranslation()
  let pct = 0
  const isHourly = (session.maxDurationSecs || 0) > 0
  if (isHourly) {
    pct = ((session.durationSecs || 0) / session.maxDurationSecs) * 100
  } else {
    const used = parseInt(session.downloadBytes || '0') + parseInt(session.uploadBytes || '0')
    const max  = parseInt(session.maxBytes || '0')
    pct = max > 0 ? (used / max) * 100 : 0
  }
  pct = Math.min(100, Math.max(0, pct))
  const color = pct > 90 ? 'var(--red)' : pct > 70 ? 'var(--orange)' : 'var(--cyan)'
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div style={{ fontSize: 9, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('node_modal.overall_usage')}</div>
        <div style={{ fontSize: 10, fontWeight: 700, color }}>{pct.toFixed(1)}%</div>
      </div>
      <div style={{ width: '100%', height: 4, background: 'var(--bg-3)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2, boxShadow: `0 0 5px ${color}`, transition: 'width .5s ease' }} />
      </div>
    </div>
  )
}

// ── ConnectedDetails: right panel when tunnel is active ────────────────────
function ConnectedDetails({ conn, onDisconnect }: { conn: ConnectionState; onDisconnect: () => void }) {
  const { t } = useTranslation()
  const [sys, setSys] = useState<any>(null)
  const isWg   = conn.vpnType === 'wireguard'
  const color  = isWg ? 'var(--purple)' : 'var(--green)'

  useEffect(() => {
    window.api.getVpnStatus().then(setSys)
    const interval = setInterval(() => window.api.getVpnStatus().then(setSys), 2500) // Polling più rapido
    return () => clearInterval(interval)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="cd-section">
        <div className="cd-section-label">{t('node_modal.system_processes')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {isWg ? (
            <>
              <div className="cd-row">
                <span>{t('node_modal.interface')}</span><span style={{ color: 'var(--text-1)' }}><code>{sys?.wgInterface || 'sentinel0'}</code></span>
              </div>
              <div className="cd-row">
                <span>{t('node_modal.driver')}</span><span style={{ color: 'var(--text-2)', fontSize: 10 }}>WireGuard (Kernel)</span>
              </div>
            </>
          ) : (
            <>
              <div className="cd-row">
                <span>{t('node_modal.v2ray_run')}</span>
                {sys?.v2rayPid ? <span className="tag tag-green" style={{ fontSize: 9 }}>PID: {sys.v2rayPid}</span> : <span className="tag tag-red">{t('node_modal.inactive')}</span>}
              </div>
              {sys?.tunActive && (
                <>
                  <div className="cd-row">
                    <span>tun2socks</span>
                    {sys.tunPid ? <span className="tag tag-purple" style={{ fontSize: 9 }}>PID: {sys.tunPid}</span> : <span className="tag tag-red">{t('node_modal.inactive')}</span>}
                  </div>
                  <div className="cd-row">
                    <span>{t('node_modal.interface')}</span><span style={{ color: 'var(--text-1)' }}><code>{sys.tunInterface}</code></span>
                  </div>
                  <div className="cd-row">
                    <span>{t('node_modal.mode')}</span><span className="tag tag-cyan" style={{ fontSize: 9 }}>🛡 {t('node_modal.transparent')}</span>
                  </div>
                </>
              )}
              {conn.inbounds && conn.inbounds.length > 0 && !sys?.tunActive && (
                <div style={{ marginTop: 4 }}>
                  <div className="cd-section-label" style={{ fontSize: 8, opacity: 0.6, marginBottom: 4 }}>{t('node_modal.active_listeners')}</div>
                  {conn.inbounds.map((ib, i) => (
                    <div key={i} className="cd-row" style={{ marginBottom: 4 }}>
                      <span style={{ fontSize: 10 }}>{ib.protocol.toUpperCase()}</span>
                      <span>
                        <code style={{ color, fontSize: 10 }}>{ib.listen}:{ib.port}</code>
                        <button
                          className="btn btn-secondary btn-sm"
                          style={{ marginLeft: 8, padding: '2px 6px', fontSize: 8 }}
                          onClick={() => navigator.clipboard.writeText(`${ib.listen}:${ib.port}`)}
                        >📋</button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="cd-section">
        <div className="cd-section-label">{t('node_modal.system_throughput')}</div>
        <TrafficStatsWidget />
      </div>

      <button className="btn btn-danger btn-full" onClick={onDisconnect} style={{ marginTop: 8 }}>
        ✕ {t('node_modal.disconnect_close')}
      </button>
    </div>
  )
}

interface LiveInfo {
  addr:          string
  moniker:       string
  downlink:      string
  uplink:        string
  handshake_dns: boolean
  peers:         number
  service_type:  string
  location?:     { city: string; country: string; country_code: string; latitude: number; longitude: number }
  version?:      { tag: string; commit: string }
}

function fmtBytesPerSec(s?: string | null): string {
  const n = parseInt(s ?? '0', 10)
  if (!n || isNaN(n)) return '—'
  if (n > 1e9) return (n / 1e9).toFixed(2) + ' GB/s'
  if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB/s'
  if (n > 1e3) return (n / 1e3).toFixed(0) + ' KB/s'
  return n + ' B/s'
}

function BwBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <span style={{ fontSize: 9, color: 'var(--text-3)', width: 70, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 4, background: 'var(--bg-3)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2, transition: 'width .4s ease' }} />
      </div>
      <span style={{ fontSize: 9, color, minWidth: 50, textAlign: 'right', fontWeight: 600, flexShrink: 0 }}>
        {fmtBytesPerSec(String(value))}
      </span>
    </div>
  )
}

function LivePanel({ node }: { node: ApiNode }) {
  const { t } = useTranslation()
  const [live, setLive]         = useState<LiveInfo | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  useEffect(() => {
    setLoading(true); setError(null); setLive(null)
    const addr = node.api.startsWith('http') ? node.api : `https://${node.api}`
    window.api.fetchNodeInfo(addr)
      .then((res: any) => {
        if (res.success && res.info) {
          const info = (res.info['result'] ?? res.info) as LiveInfo
          setLive(info)
        } else {
          setError(res.error ?? t('node_modal.node_unreachable'))
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [node.address, node.api, t])

  const up   = parseInt(live?.uplink   ?? '0', 10)
  const down = parseInt(live?.downlink ?? '0', 10)
  const max  = Math.max(up, down, 1)

  return (
    <div className="ncm-live-panel">
      <div className="ncm-live-section-label">{t('node_modal.node_identity')}</div>
      <div className="ncm-stat-row">
        <span>{t('node_modal.address')}</span>
        <span className="ncm-stat-mono" title={node.address}>{node.address.slice(0, 26)}…</span>
      </div>
      <div className="ncm-stat-row">
        <span>{t('node_modal.endpoint')}</span>
        <span className="ncm-stat-mono">{node.api}</span>
      </div>
      <div className="ncm-stat-row">
        <span>{t('table.type')}</span>
        <span className={`td-type ${node.type === 1 ? 'wireguard' : 'v2ray'}`} style={{ fontSize: 9 }}>
          {vpnTypeLabel(node.type)}
        </span>
      </div>
      <div className="ncm-stat-row">
        <span>{t('common.version')}</span>
        <a 
          href={`https://github.com/sentinel-official/sentinel-dvpnx/releases/tag/v${node.version}`}
          target="_blank" rel="noreferrer"
          style={{ color: 'var(--cyan)', fontSize: 10, textDecoration: 'none', fontWeight: 600 }}
          onMouseOver={e => e.currentTarget.style.textDecoration = 'underline'}
          onMouseOut={e => e.currentTarget.style.textDecoration = 'none'}
        >
          v{node.version}
        </a>
      </div>

      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', margin: '10px 0' }}>
        <span className={`tag ${node.isActive ? 'tag-green' : 'tag-red'}`} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {node.isActive ? `● ${t('table.active_status').toUpperCase()}` : `○ ${t('table.inactive_status').toUpperCase()}`}
        </span>
        <span className={`tag ${node.isHealthy ? 'tag-green' : 'tag-yellow'}`} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ filter: `drop-shadow(0 0 3px ${node.isHealthy ? 'var(--cyan)' : 'var(--red)'})` }}>
            {node.isHealthy ? '♥' : '✗'}
          </span>
          {node.isHealthy ? t('table.healthy_status').toUpperCase() : t('table.unhealthy_status').toUpperCase()}
        </span>
        {node.isWhitelisted && <span className="tag tag-green">{t('filters.listed').toUpperCase()}</span>}
        {node.isResidential && <span className="tag tag-cyan">{t('common.residential').toUpperCase()}</span>}
      </div>

      <div className="ncm-divider" />
      <div className="ncm-live-section-label" style={{ gap: 8, display: 'flex', alignItems: 'center' }}>
        {t('node_modal.real_time_status')}
        {/* loading && <div className="spinner" style={{ width: 10, height: 10 }} /> */}
      </div>

      {loading && !live && (
        <div style={{ padding: '20px 0', textAlign: 'center' }}>
          <div className="spinner" style={{ width: 24, height: 24, margin: '0 auto 10px' }} />
          <div style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.1em' }}>{t('node_modal.polling_node')}</div>
        </div>
      )}

      {error && !loading && <div style={{ fontSize: 10, color: 'var(--red)', lineHeight: 1.6, marginBottom: 8 }}>⚠ {error}</div>}

      {live && (
        <>
          <div className="ncm-stat-row">
            <span>{t('node_modal.live_peers')}</span>
            <span style={{ color: 'var(--cyan)', fontWeight: 700, fontSize: 16 }}>{live.peers}</span>
          </div>
          <div className="ncm-stat-row">
            <span>{t('node_modal.service')}</span>
            <span style={{
              color: live.service_type === 'wireguard' ? 'var(--purple)' : 'var(--green)',
              textTransform: 'uppercase', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em'
            }}>
              {live.service_type}
            </span>
          </div>
          <div className="ncm-stat-row">
            <span>{t('node_modal.dns_handshake')}</span>
            <span style={{ color: live.handshake_dns ? 'var(--green)' : 'var(--text-3)' }}>
              {live.handshake_dns ? `✓ ${t('common.yes')}` : `✗ ${t('common.no')}`}
            </span>
          </div>
          {live.version?.commit && (
            <div className="ncm-stat-row">
              <span>Commit</span>
              <a 
                href={`https://github.com/sentinel-official/sentinel-dvpnx/commit/${live.version.commit}`}
                target="_blank" rel="noreferrer"
                className="ncm-stat-mono"
                style={{ color: 'var(--cyan)', fontSize: 9, textDecoration: 'none', fontWeight: 600 }}
                onMouseOver={e => e.currentTarget.style.textDecoration = 'underline'}
                onMouseOut={e => e.currentTarget.style.textDecoration = 'none'}
              >
                {live.version.commit.slice(0, 10)}
              </a>
            </div>
          )}

          <div className="ncm-divider" />
          <div className="ncm-live-section-label">{t('node_modal.throughput')}</div>
          <BwBar label={`↓ ${t('node_modal.download')}`} value={down} max={max} color="var(--purple)" />
          <BwBar label={`↑ ${t('node_modal.upload')}`}   value={up}   max={max} color="var(--green)" />

          {live.location && (
            <>
              <div className="ncm-divider" />
              <div className="ncm-stat-row">
                <span>📍 {t('ip.location')}</span>
                <span style={{ color: 'var(--text-2)', fontSize: 10 }}>
                  {live.location.city}, {live.location.country_code}
                </span>
              </div>
              <div className="ncm-stat-row">
                <span>Coords</span>
                <span style={{ fontSize: 9, color: 'var(--text-3)', fontFamily: 'monospace' }}>
                  {live.location.latitude.toFixed(3)}, {live.location.longitude.toFixed(3)}
                </span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function ErrorStep({ error, onRetryTunnel, onRetryFull, onClose, hasConfig }: any) {
  const { t } = useTranslation()
  return (
    <>
      <div className="error-box" style={{ whiteSpace: 'pre-wrap' }}>
        <div className="error-label">{t('common.error')}</div>
        {error}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {hasConfig && (
          <button className="btn btn-primary btn-full" onClick={onRetryTunnel}>
            ↺ {t('node_modal.retry_tunnel')}
          </button>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onRetryFull}>
            ⚡ {t('node_modal.new_subscription')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </>
  )
}

interface Props {
  node:            ApiNode
  bookmarked:      boolean
  onBookmark:      () => void
  onClose:         () => void
  onConnected:     (state: ConnectionState) => void
  infoOnly?:       boolean
  initialSessionId?: string | null
}

export default function NodeConnectModal({
  node, bookmarked, onBookmark, onClose, onConnected, infoOnly = false, initialSessionId = null
}: Props) {
  const { t } = useTranslation()
  const [conn, setConn]               = useState<ConnectionState>({ ...INITIAL_CONNECTION, node, sessionId: initialSessionId, step: initialSessionId ? 'fetching_node' : 'choose-type' })
  const [showWgQr, setShowWgQr]       = useState(false)
  const [expandedQr, setExpandedQr]   = useState<number | null>(null)
  const [tunnelBusy, setTunnelBusy]   = useState(false)
  const [binaries, setBinaries]       = useState<BinaryStatus | null>(null)
  const [hasConfig, setHasConfig]     = useState(false)
  const [sessionInfo, setSessionInfo] = useState<any>(null)
  const [loadingSession, setLoadingSession] = useState(false)

  const vpnName = node.type === 1 ? 'WireGuard' : 'V2Ray'

  useEffect(() => {
    window.api.checkBinaries().then((b: any) => setBinaries(b))
    if (infoOnly) {
      setLoadingSession(true)
      window.api.getWalletInfo().then((res: any) => {
        if (res.success && res.sessions) {
          const active = res.sessions.find((s: any) => s.nodeAddress === node.address && s.status === 1)
          if (active) setSessionInfo(active)
        }
      }).finally(() => setLoadingSession(false))
    }
  }, [infoOnly, node.address])

  useEffect(() => {
    const unsub = window.api.onVpnStatus((status: any) => {
      if (status.step) {
        setConn(s => ({ ...s, step: status.step as any, sessionId: status.sessionId ?? s.sessionId }))
      }
    })
    return () => { unsub() }
  }, [])

  const handleConnect = useCallback(async (existingSessionId?: string) => {
    setConn(s => ({ ...s, step: 'fetching_node', error: null }))
    try {
      let res: any
      if (existingSessionId) {
        res = await window.api.connectSession({
          nodeAddress: node.address,
          sessionId:   parseInt(existingSessionId)
        })
      } else {
        res = await window.api.connectNode({
          nodeAddress:      node.address,
          subscriptionType: conn.subscriptionType,
          amount:           conn.amount
        })
      }

      if (!res.success) {
        setConn(s => ({ ...s, step: 'error', error: res.error ?? 'Failed' }))
        return
      }
      setHasConfig(false)
      if (res.vpnType === 'wireguard') {
        setHasConfig(true)
        setConn(s => ({ ...s, step: 'wg-options', sessionId: res.sessionId, vpnType: 'wireguard', configStr: res.configStr, wgQrCode: res.qrCode }))
      } else {
        setHasConfig(true)
        setConn(s => ({ ...s, step: 'v2ray-options', sessionId: res.sessionId, vpnType: 'v2ray', shareLinks: res.shareLinks ?? [], v2rayQrCodes: res.qrCodes ?? [], inbounds: res.inbounds ?? [] }))
      }
    } catch (e: any) {
      setConn(s => ({ ...s, step: 'error', error: e.message ?? String(e) }))
    }
  }, [node.address, conn.subscriptionType, conn.amount])

  useEffect(() => {
    if (initialSessionId) handleConnect(initialSessionId)
  }, [initialSessionId, handleConnect])

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [onClose])

  const handleWgConnect = useCallback(async () => {
    setTunnelBusy(true)
    try {
      const res = await window.api.connectWireGuard()
      if (!res.success) { setConn(s => ({ ...s, step: 'error', error: res.error ?? 'wg-quick failed' })); return }
      const next = { ...conn, step: 'connected' as const }
      setConn(next); onConnected(next)
    } finally { setTunnelBusy(false) }
  }, [conn, onConnected])

  const handleV2RayConnect = useCallback(async (isTransparent?: boolean) => {
    setTunnelBusy(true)
    setConn(s => ({ ...s, isTransparent: !!isTransparent }))
    try {
      const res = await window.api.connectV2Ray({ transparent: !!isTransparent })
      if (!res.success) { setConn(s => ({ ...s, step: 'error', error: res.error ?? 'v2ray failed' })); return }
      const next = { ...conn, step: 'connected' as const }
      setConn(next); onConnected(next)
    } finally { setTunnelBusy(false) }
  }, [conn, onConnected])

  const handleRetryTunnel = useCallback(async () => {
    setTunnelBusy(true)
    setConn(s => ({ ...s, step: conn.vpnType === 'wireguard' ? 'wg-options' : 'v2ray-options', error: null }))
    try {
      const res = await window.api.retryTunnel({ transparent: !!conn.isTransparent })
      if (!res.success) {
        setConn(s => ({ ...s, step: 'error', error: res.error ?? 'Retry failed' }))
      } else {
        const next = { ...conn, step: 'connected' as const }
        setConn(next); onConnected(next)
      }
    } finally { setTunnelBusy(false) }
  }, [conn, onConnected])

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ncm-shell">
        <div className="ncm-topbar">
          <div className="ncm-topbar-title">
            <span style={{ fontSize: 16, marginRight: 6 }}>{countryToFlag(node.country ?? '')}</span>
            <span>{node.moniker}</span>
            <span className="ncm-topbar-sub">{node.city}, {node.country}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm btn-secondary" style={{ color: bookmarked ? 'var(--yellow)' : undefined }} onClick={onBookmark}>
              {bookmarked ? `★ ${t('filters.listed')}` : `☆ ${t('common.save')}`}
            </button>
            <button className="modal-close" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="ncm-body">
          <LivePanel node={node} />
          <div className="ncm-right-panel">
            {infoOnly ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="session-banner ok">{t('node_modal.currently_connected')}</div>
                <div className="ncm-live-section-label">{t('node_modal.pricing')}</div>
                <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.8 }}>
                  {t('node_modal.gb_price')}: <strong style={{ color: 'var(--yellow)' }}>{formatUdvpnPrice(node.gigabytePrices)} / GB</strong>
                  <br />
                  {t('node_modal.hr_price')}: <strong style={{ color: 'var(--orange)' }}>{formatUdvpnPrice(node.hourlyPrices)} / hr</strong>
                </div>
                
                {loadingSession && !sessionInfo && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20, color: 'var(--text-3)' }}>
                    <div className="spinner" style={{ width: 14, height: 14 }} />
                    <span style={{ fontSize: 10 }}>{t('node_modal.fetching_session_info')}</span>
                  </div>
                )}

                {sessionInfo && (
                  <>
                    <div className="ncm-divider" />
                    <div className="ncm-live-section-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>{t('node_modal.active_session_on_chain')}</span>
                      <span style={{ color: 'var(--cyan)', opacity: 0.8 }}>#{sessionInfo.id}</span>
                    </div>
                    <div className="session-stats-grid">
                      <div className="session-stat-box">
                        <div className="label">{t('node_modal.used')}</div>
                        <div className="value">{((parseInt(sessionInfo.downloadBytes || '0') + parseInt(sessionInfo.uploadBytes || '0')) / 1e6).toFixed(1)} MB</div>
                      </div>
                      <div className="session-stat-box">
                        <div className="label">{t('node_modal.quota')}</div>
                        <div className="value">{(parseInt(sessionInfo.maxBytes || '0') / 1e9).toFixed(1)} GB</div>
                      </div>
                      <div className="session-stat-box">
                        <div className="label">{t('node_modal.duration')}</div>
                        <div className="value">{((sessionInfo.durationSecs || 0) / 60).toFixed(0)} min</div>
                      </div>
                    </div>
                    <UsageProgress session={sessionInfo} />
                    <style dangerouslySetInnerHTML={{ __html: `
                      .session-stats-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-top: 5px; }
                      .session-stat-box { background: var(--bg-2); padding: 8px; border-radius: var(--radius-sm); border: 1px solid var(--border); }
                      .session-stat-box .label { font-size: 9px; color: var(--text-3); text-transform: uppercase; margin-bottom: 2px; }
                      .session-stat-box .value { font-size: 11px; font-weight: 600; color: var(--cyan); }
                    `}} />
                  </>
                )}

                {/* System details independent of on-chain session info */}
                {(conn.step === 'connected' || infoOnly) && (
                  <>
                    <div className="ncm-divider" />
                    <ConnectedDetails 
                      conn={{
                        ...conn,
                        step: 'connected',
                        vpnType: node.type === 1 ? 'wireguard' : 'v2ray'
                      }} 
                      onDisconnect={async () => { await window.api.disconnectNode(); onClose() }} 
                    />
                  </>
                )}

                <div style={{ flex: 1 }} />
                {!sessionInfo && !loadingSession && !infoOnly && (
                  <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start', marginTop: 20 }} onClick={onClose}>{t('common.close')}</button>
                )}
                {infoOnly && !loadingSession && !sessionInfo && (
                   <div style={{ fontSize: 10, color: 'var(--text-3)', fontStyle: 'italic', marginTop: 10 }}>
                     {t('node_modal.session_not_found')}
                   </div>
                )}
              </div>
            ) : (
              <>
                {conn.step === 'choose-type' && (
                  <>
                    <div className="ncm-price-pair">
                      <div className="ncm-price-item">
                        <div className="ncm-price-item-label">{t('node_modal.per_gb')}</div>
                        <div className="ncm-price-item-value" style={{ color: 'var(--yellow)' }}>{formatUdvpnPrice(node.gigabytePrices)}</div>
                      </div>
                      <div className="ncm-price-item">
                        <div className="ncm-price-item-label">{t('node_modal.per_hr')}</div>
                        <div className="ncm-price-item-value" style={{ color: 'var(--orange)' }}>{formatUdvpnPrice(node.hourlyPrices)}</div>
                      </div>
                    </div>
                    <div className="ncm-price-hint">ⓘ {t('node_modal.indicative_prices')}</div>
                    <div className="ncm-divider" />
                    <div className="ncm-right-label">{t('node_modal.subscription_type')}</div>
                    <div className="sub-type-row" style={{ marginBottom: 14 }}>
                      {(['gigabytes', 'hours'] as SubscriptionType[]).map(st => (
                        <div key={st} className={`sub-type-btn ${conn.subscriptionType === st ? 'selected' : ''}`} onClick={() => setConn(s => ({ ...s, subscriptionType: st }))}>
                          <div className="sub-type-icon">{st === 'gigabytes' ? '📦' : '⏳'}</div>
                          <div className="sub-type-label">{st === 'gigabytes' ? t('node_modal.gigabytes') : t('node_modal.hours')}</div>
                          <div className="sub-type-price">{st === 'gigabytes' ? formatUdvpnPrice(node.gigabytePrices) + ' / GB' : formatUdvpnPrice(node.hourlyPrices) + ' / hr'}</div>
                        </div>
                      ))}
                    </div>
                    <div className="ncm-right-label">{t('node_modal.amount')}</div>
                    <div className="amount-row" style={{ marginBottom: 18 }}>
                      <button className="btn btn-secondary" style={{ padding: '10px 14px', fontSize: 18 }} onClick={() => setConn(s => ({ ...s, amount: Math.max(1, s.amount - 1) }))}>−</button>
                      <input type="number" className="amount-input" min={1} value={conn.amount} onChange={e => setConn(s => ({ ...s, amount: Math.max(1, parseInt(e.target.value) || 1) }))} />
                      <button className="btn btn-secondary" style={{ padding: '10px 14px', fontSize: 18 }} onClick={() => setConn(s => ({ ...s, amount: s.amount + 1 }))}>+</button>
                      <span className="amount-unit">{conn.subscriptionType === 'gigabytes' ? 'GB' : 'HR'}</span>
                    </div>
                    <button className="btn btn-primary btn-full" onClick={() => handleConnect()}>⚡ {t('node_modal.subscribe_connect', { name: vpnName })}</button>
                  </>
                )}

                {[
                  'fetching_node', 'preparing_tx', 'signing_tx', 'broadcasting_tx', 'extracting_tx',
                  'fetching_node_info', 'handshaking', 'generating_config', 'wg_dns_retry'
                ].includes(conn.step as string) && (
                  <>
                    <div className="loading-row">
                      <div className="spinner" />
                      <div>
                        {conn.step === 'fetching_node' && t('node_modal.step.fetching_node')}
                        {conn.step === 'preparing_tx' && t('node_modal.step.preparing_tx')}
                        {conn.step === 'signing_tx' && t('node_modal.step.signing_tx')}
                        {conn.step === 'broadcasting_tx' && t('node_modal.step.broadcasting_tx')}
                        {conn.step === 'extracting_tx' && t('node_modal.step.extracting_tx')}
                        {conn.step === 'fetching_node_info' && t('node_modal.step.fetching_node_info')}
                        {conn.step === 'handshaking' && t('node_modal.step.handshaking', { name: vpnName })}
                        {conn.step === 'generating_config' && t('node_modal.step.generating_config')}
                      </div>
                    </div>
                    <div className="step-progress-list">
                      {[
                        { id: 'fetching_node', label: t('node_modal.locate_node') },
                        { id: 'preparing_tx', label: t('node_modal.prepare_msg') },
                        { id: 'signing_tx', label: t('node_modal.sign_tx') },
                        { id: 'broadcasting_tx', label: t('node_modal.broadcast_tx') },
                        { id: 'extracting_tx', label: t('node_modal.extract_session') },
                        { id: 'handshaking', label: t('node_modal.node_handshake') },
                      ].map((s) => {
                        const steps = ['fetching_node', 'preparing_tx', 'signing_tx', 'broadcasting_tx', 'extracting_tx', 'fetching_node_info', 'handshaking', 'generating_config', 'wg_dns_retry']
                        const curIdx = steps.indexOf(conn.step as string)
                        const itemIdx = steps.indexOf(s.id)
                        let status = 'pending'
                        if (conn.step === 'handshaking' || conn.step === 'fetching_node_info' || conn.step === 'generating_config' || conn.step === 'wg_dns_retry') {
                           if (s.id === 'handshaking') status = (conn.step === 'generating_config' || conn.step === 'wg_dns_retry') ? 'done' : 'active'
                           else status = 'done'
                        } else if (itemIdx < curIdx) status = 'done'
                        else if (conn.step === s.id) status = 'active'
                        return (
                          <div key={s.id} className={`step-item ${status}`}>
                            <div className="step-dot" /><div className="step-label">{s.label}</div>
                          </div>
                        )
                      })}
                    </div>
                    <style dangerouslySetInnerHTML={{ __html: `
                      .step-progress-list { margin-top: 20px; display: flex; flex-direction: column; gap: 10px; }
                      .step-item { display: flex; align-items: center; gap: 12px; opacity: 0.4; transition: all 0.3s ease; }
                      .step-item.active { opacity: 1; color: var(--cyan); transform: translateX(5px); }
                      .step-item.done { opacity: 0.8; color: var(--green); }
                      .step-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); }
                      .step-item.active .step-dot { background: var(--cyan); box-shadow: 0 0 8px var(--cyan); }
                      .step-item.done .step-dot { background: var(--green); }
                    `}} />
                  </>
                )}

                {conn.step === 'wg-options' && (
                  <>
                    <div className="session-banner">✓ {t('vpn.status')} #{conn.sessionId}</div>
                    {conn.configStr && <div className="wg-config-block" style={{ fontSize: 9, maxHeight: 130, overflowY: 'auto' }}>{conn.configStr}</div>}
                    <button className="btn btn-purple btn-sm" style={{ marginBottom: 10 }} onClick={() => setShowWgQr(v => !v)}>{showWgQr ? `▲ ${t('node_modal.hide_qr')}` : `▼ ${t('node_modal.show_qr')}`}</button>
                    {showWgQr && conn.wgQrCode && <div className="qr-container" style={{ marginBottom: 14 }}><img src={conn.wgQrCode} alt="WG QR" style={{ width: 200, height: 200 }} /></div>}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-primary" style={{ flex: 1 }} disabled={tunnelBusy} onClick={handleWgConnect}>{tunnelBusy ? t('vpn.connecting') : `⬡ ${vpnName} up`}</button>
                      <button className="btn btn-secondary btn-sm" onClick={onClose}>{t('node_modal.qr_only')}</button>
                    </div>
                  </>
                )}

                {conn.step === 'v2ray-options' && (
                  <>
                    <div className="session-banner">✓ {t('vpn.status')} #{conn.sessionId}</div>
                    {conn.v2rayQrCodes.length > 0 && (
                      <div style={{ marginBottom: 14 }}>
                        {conn.v2rayQrCodes.map((qr, i) => {
                          const isVMess = conn.shareLinks[i]?.startsWith('vmess://')
                          return (
                            <div key={i} style={{ marginBottom: 8 }}>
                              <button className="btn btn-purple btn-sm" onClick={() => setExpandedQr(expandedQr === i ? null : i)}>
                                {expandedQr === i ? `▲ ${t('node_modal.hide_qr')}` : '▼'} Link {isVMess ? 'VMess' : 'VLess'}
                              </button>
                              {expandedQr === i && (
                                <div className="qr-container" style={{ padding: 12 }}>
                                  <img src={qr} alt={`QR ${i}`} style={{ width: 180, height: 180 }} />
                                  <div style={{ fontSize: 9, wordBreak: 'break-all' }}>{conn.shareLinks[i]}</div>
                                  <button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(conn.shareLinks[i] ?? '')}>📋 {t('common.copy')}</button>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                    <div className="ncm-divider">{t('node_modal.or_start_proxy')}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <button className="btn btn-primary" style={{ flex: 1 }} disabled={tunnelBusy} onClick={() => handleV2RayConnect(false)}>{tunnelBusy ? t('common.starting') : `▶ ${t('node_modal.start_proxy')}`}</button>
                      <button className="btn btn-purple" style={{ flex: 1 }} disabled={tunnelBusy || !binaries?.tun2socksPath} onClick={() => handleV2RayConnect(true)}>{tunnelBusy ? t('common.starting') : `🛡 ${t('node_modal.start_transparent')}`}</button>
                      <button className="btn btn-secondary btn-sm" onClick={onClose}>{t('node_modal.qr_only')}</button>
                    </div>
                  </>
                )}

                {conn.step === 'connected' && <ConnectedDetails conn={conn} onDisconnect={async () => { await window.api.disconnectNode(); onClose() }} />}
                {conn.step === 'error' && <ErrorStep error={conn.error} hasConfig={hasConfig} onRetryTunnel={handleRetryTunnel} onRetryFull={() => setConn(s => ({ ...s, step: 'choose-type', error: null }))} onClose={onClose} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

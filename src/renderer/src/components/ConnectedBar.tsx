import React from 'react'
import { useTranslation } from 'react-i18next'
import { ConnectionState } from '../types'
import TrafficStatsWidget from './TrafficStats'

interface Props {
  connection: ConnectionState
  reconnectMsg?: string | null
  onDisconnect: () => void
  onManage: () => void
}

export default function ConnectedBar({ connection, reconnectMsg, onDisconnect, onManage }: Props) {
  const { t } = useTranslation()
  const { node, vpnType, sessionId, inbounds } = connection

  return (
    <div className="connected-panel">
      {reconnectMsg ? (
        <div className="reconnect-banner">
          <div className="spinner" style={{ width: 12, height: 12, flexShrink: 0 }} />
          <span>{reconnectMsg}</span>
        </div>
      ) : (
        <div className="connected-indicator">
          <span className="dot" />
          <span>{t('vpn.connected').toUpperCase()}</span>
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--text-2)', flexShrink: 0 }}>
        {node?.moniker ?? 'Unknown'} · {vpnType === 'wireguard' ? 'WireGuard' : 'V2Ray'}
        {sessionId && <span style={{ color: 'var(--text-3)', fontSize: 10, marginLeft: 8 }}>#{sessionId}</span>}
      </div>

      {vpnType === 'v2ray' && inbounds && inbounds.length > 0 && (
        <div className="proxy-chips">
          {inbounds.map((ib, i) => (
            <span key={i} className="proxy-chip">{ib.protocol.toUpperCase()} :{ib.port}</span>
          ))}
        </div>
      )}

      <TrafficStatsWidget />

      <div className="connected-actions">
        <button className="btn btn-secondary btn-sm" onClick={onManage}>⬡ {t('vpn.manage_btn')}</button>
        <button className="btn btn-danger btn-sm" onClick={onDisconnect}>✕ {t('vpn.disconnect_btn')}</button>
      </div>
    </div>
  )
}

import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import RpcSelector from './RpcSelector'
import ConfirmModal from './ConfirmModal'

interface IpInfo {
  ip?: string
  city?: string
  country_name?: string
  org?: string
  asn?: string
  error?: string
}

interface Props {
  currentRpc?:   string
  showRpc?:      boolean
  onRpcChanged?: (url: string) => void
  ipInfo?:       IpInfo | null
  onRefreshIp?:  () => void
}

export default function TitleBar({ currentRpc, showRpc, onRpcChanged, ipInfo, onRefreshIp }: Props) {
  const { t } = useTranslation()
  const [showDetails, setShowDetails] = useState(false)

  useEffect(() => {
    if (!showDetails) return
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowDetails(false) }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [showDetails])

  return (
    <div className="titlebar">
      <div className="titlebar-logo">
        <div className="logo-mark" />
        <div>
          <div className="logo-text">SENTINEL dVPN</div>
          <div className="logo-sub">DECENTRALIZED VIRTUAL PRIVATE NETWORK</div>
        </div>
      </div>

      {/* Live IP Display */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 20 }}>
        {!ipInfo ? (
          <div className="live-ip-badge loading">
            <div className="spinner" style={{ width: 10, height: 10 }} />
            <span className="live-ip-label">{t('ip.detecting')}</span>
          </div>
        ) : ipInfo.error ? (
          <div className="live-ip-badge error" onClick={() => setShowDetails(true)} title={ipInfo.error}>
            <span className="live-ip-dot" style={{ background: 'var(--red)', boxShadow: '0 0 6px var(--red)' }} />
            <span className="live-ip-label">{t('ip.error')}</span>
          </div>
        ) : (
          <div className="live-ip-badge" onClick={() => setShowDetails(true)} title={t('ip.click_details')}>
            <span className="live-ip-dot" />
            <span className="live-ip-label">{t('ip.live_ip')}:</span>
            <span className="live-ip-value">{ipInfo.ip}</span>
          </div>
        )}
        
        {ipInfo && (
          <button 
            className="title-icon-btn" 
            onClick={() => onRefreshIp?.()}
            title={t('common.refresh')}
          >
            <span style={{ fontSize: 16 }}>↻</span>
          </button>
        )}
      </div>

      {/* RPC selector */}
      {showRpc && currentRpc && onRpcChanged && (
        <div style={{ marginLeft: 'auto', marginRight: 12 }}>
          <RpcSelector currentRpc={currentRpc} onChanged={onRpcChanged} />
        </div>
      )}

      <div className="titlebar-controls" style={{ marginLeft: showRpc ? 0 : 'auto' }}>
        <button className="win-btn" onClick={() => window.api.minimizeWindow()} title={t('common.minimize')}>─</button>
        <button className="win-btn" onClick={() => window.api.maximizeWindow()} title={t('common.maximize')}>▢</button>
        <button className="win-btn close" onClick={() => window.api.closeWindow()} title={t('common.close')}>✕</button>
      </div>

      {/* IP Details Modal */}
      {showDetails && ipInfo && (
        <ConfirmModal
          title={t('ip.title')}
          confirmLabel={t('common.close')}
          cancelLabel=""
          onConfirm={() => setShowDetails(false)}
          onCancel={() => setShowDetails(false)}
          message={
            ipInfo.error ? (
              <div style={{ color: 'var(--red)', fontSize: 11, lineHeight: 1.6 }}>
                <strong>{t('ip.fetch_failed')}</strong><br />
                {ipInfo.error}<br /><br />
                {t('ip.check_connection')}
              </div>
            ) : (
              <div className="ip-details-grid">
                <div className="ip-detail-item">
                  <div className="label">{t('ip.public_ip')}</div>
                  <div className="value" style={{ color: 'var(--cyan)', fontSize: 16 }}>{ipInfo.ip}</div>
                </div>
                <div className="ip-detail-item">
                  <div className="label">{t('ip.location')}</div>
                  <div className="value">{ipInfo.city}, {ipInfo.country_name}</div>
                </div>
                <div className="ip-detail-item">
                  <div className="label">{t('ip.asn_provider')}</div>
                  <div className="value" style={{ fontSize: 10 }}>{ipInfo.org} ({ipInfo.asn})</div>
                </div>
                <style dangerouslySetInnerHTML={{ __html: `
                  .ip-details-grid { display: flex; flex-direction: column; gap: 16px; padding: 10px 0; }
                  .ip-detail-item .label { font-size: 9px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px; }
                  .ip-detail-item .value { font-weight: 600; color: var(--text-1); }
                `}} />
              </div>
            )
          }
        />
      )}

      <style dangerouslySetInnerHTML={{ __html: `
        .live-ip-badge {
          display: flex;
          align-items: center;
          gap: 8px;
          background: rgba(0, 229, 255, 0.05);
          border: 1px solid rgba(0, 229, 255, 0.2);
          padding: 4px 12px;
          border-radius: 4px;
          cursor: pointer;
          margin-left: 20px;
          transition: all 0.2s;
          -webkit-app-region: no-drag;
        }
        .live-ip-badge:hover {
          background: rgba(0, 229, 255, 0.1);
          border-color: var(--cyan);
          box-shadow: 0 0 10px rgba(0, 229, 255, 0.2);
        }
        .live-ip-badge.loading {
          cursor: default;
          opacity: 0.7;
        }
        .live-ip-dot {
          width: 6px;
          height: 6px;
          background: var(--green);
          border-radius: 50%;
          box-shadow: 0 0 6px var(--green);
        }
        .live-ip-label {
          font-size: 9px;
          font-weight: 700;
          color: var(--text-3);
          letter-spacing: 0.05em;
        }
        .live-ip-value {
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--cyan);
          font-weight: 600;
        }
        .title-icon-btn {
          background: var(--bg-2);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text-3);
          cursor: pointer;
          width: 26px;
          height: 26px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
          -webkit-app-region: no-drag;
        }
        .title-icon-btn:hover {
          border-color: var(--cyan);
          color: var(--cyan);
          background: var(--bg-3);
          box-shadow: 0 0 8px rgba(0, 229, 255, 0.2);
        }
      `}} />
    </div>
  )
}

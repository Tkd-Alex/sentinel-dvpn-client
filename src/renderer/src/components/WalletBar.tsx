import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { WalletInfo } from '../types'
import { formatBalance, truncateAddress } from '../utils'

interface Props {
  onForget: () => void
}

export default function WalletBar({ onForget }: Props) {
  const { t } = useTranslation()
  const [info, setInfo] = useState<WalletInfo | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.getWalletInfo()
      if (res.success) setInfo(res as WalletInfo)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    const unsub = window.api.onWalletChanged(() => {
      console.log('[WalletBar] Wallet changed event received, reloading...')
      load()
    })
    return () => { clearInterval(id); unsub() }
  }, [load])

  return (
    <div className="wallet-bar">
      {/* Status dot + address */}
      <div className="wallet-addr">
        <span className="dot" />
        <span title={info?.address ?? ''}>
          {info?.address ? info.address : t('common.loading_simple')}
        </span>
      </div>

      {/* Balances */}
      {info?.balances && info.balances.length > 0 && (
        <div className="balance-chips">
          {info.balances.slice(0, 3).map(b => (
            <span key={b.denom} className="balance-chip" title={`${b.amount} ${b.denom}`}>
              {formatBalance(b.amount, b.denom)}
            </span>
          ))}
        </div>
      )}

      {/* P2P sessions counter */}
      {info && (
        <div className="sessions-badge" title={t('wallet.active_sessions_hint')}>
          <span>⬡</span>
          <span>
            {Array.isArray(info.sessions) ? info.sessions.length : 0} {Array.isArray(info.sessions) && info.sessions.length === 1 ? t('wallet.p2p_session') : t('wallet.p2p_session_plural')}
          </span>
        </div>
      )}

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-3)', fontSize: 10 }}>
          <div className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
          <span>{t('common.syncing')}</span>
        </div>
      )}

      <div className="wallet-bar-actions">
        <button className="btn btn-secondary btn-sm" onClick={load} title={t('wallet.refresh_info')}>
          ↻ {t('common.refresh')}
        </button>
        {/* <button className="btn btn-danger btn-sm" onClick={onForget} title="Remove stored wallet">
          🗑 Forget
        </button> */}
      </div>
    </div>
  )
}

import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ChainSession, ApiNode } from '../types'
import { countryToFlag } from '../utils'
import ConfirmModal from './ConfirmModal'

function fmtBytes(s?: string | null): string {
  const n = parseInt(s ?? '0', 10)
  if (!n || isNaN(n)) return '—'
  if (n > 1e9) return (n / 1e9).toFixed(2) + ' GB'
  if (n > 1e6) return (n / 1e6).toFixed(2) + ' MB'
  if (n > 1e3) return (n / 1e3).toFixed(1) + ' KB'
  return n + ' B'
}

function fmtDuration(secs: number): string {
  if (!secs) return '—'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${secs}s`
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) }
  catch { return iso }
}

function fmtPrice(price: ChainSession['price'], isHourly: boolean): string {
  if (!price) return '—'
  const suffix = isHourly ? '/ hr' : '/ GB'
  // Use quoteValue (udvpn) for the actual user price
  const val = parseFloat(price.quoteValue || '0') / 1_000_000
  return `${val.toFixed(2)} DVPN ${suffix}`
}

function statusInfo(s: number): { label: string; cls: string } {
  switch (s) {
    case 1: return { label: 'ACTIVE',           cls: 'tag-green'  }
    case 2: return { label: 'INACTIVE PENDING', cls: 'tag-yellow' }
    case 3: return { label: 'INACTIVE',         cls: 'tag-grey'   }
    default: return { label: `STATUS ${s}`,     cls: 'tag-grey'   }
  }
}

function BwMini({ dl, ul }: { dl: string; ul: string }) {
  const d = parseInt(dl ?? '0', 10) || 0
  const u = parseInt(ul ?? '0', 10) || 0
  const max = Math.max(d, u, 1)
  return (
    <div style={{ minWidth: 110 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
        <span style={{ fontSize: 8, color: 'var(--purple)', width: 8 }}>↓</span>
        <div style={{ flex: 1, height: 3, background: 'var(--bg-3)', borderRadius: 2 }}>
          <div style={{ width: `${(d/max)*100}%`, height: '100%', background: 'var(--purple)', borderRadius: 2 }} />
        </div>
        <span style={{ fontSize: 8, color: 'var(--purple)', minWidth: 45, textAlign: 'right' }}>{fmtBytes(dl)}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ fontSize: 8, color: 'var(--green)', width: 8 }}>↑</span>
        <div style={{ flex: 1, height: 3, background: 'var(--bg-3)', borderRadius: 2 }}>
          <div style={{ width: `${(u/max)*100}%`, height: '100%', background: 'var(--green)', borderRadius: 2 }} />
        </div>
        <span style={{ fontSize: 8, color: 'var(--green)', minWidth: 45, textAlign: 'right' }}>{fmtBytes(ul)}</span>
      </div>
    </div>
  )
}

function UsageProgress({ session }: { session: ChainSession }) {
  let pct = 0
  const isHourly = session.maxDurationSecs > 0
  if (isHourly) {
    pct = (session.durationSecs / session.maxDurationSecs) * 100
  } else {
    const used = parseInt(session.downloadBytes) + parseInt(session.uploadBytes)
    const max  = parseInt(session.maxBytes)
    pct = max > 0 ? (used / max) * 100 : 0
  }
  pct = Math.min(100, Math.max(0, pct))
  const color = pct > 90 ? 'var(--red)' : pct > 70 ? 'var(--orange)' : 'var(--cyan)'
  return (
    <div style={{ minWidth: 80 }}>
      <div style={{ fontSize: 9, marginBottom: 4, color: 'var(--text-3)', textAlign: 'right' }}>{pct.toFixed(1)}%</div>
      <div style={{ width: '100%', height: 4, background: 'var(--bg-3)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2, boxShadow: `0 0 5px ${color}` }} />
      </div>
    </div>
  )
}

interface Props {
  nodes?: ApiNode[]
  onConnectSession?: (nodeAddress: string, sessionId: number) => void
}

export default function SessionPanel({ nodes = [], onConnectSession }: Props) {
  const { t } = useTranslation()
  const [sessions,   setSessions]   = useState<ChainSession[]>([])
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<number | null>(null)
  const [connecting, setConnecting] = useState<number | null>(null)
  const [confirmId, setConfirmId]   = useState<number | null>(null)

  function statusInfo(s: number): { label: string; cls: string } {
    switch (s) {
      case 1: return { label: t('sessions.status.active'),           cls: 'tag-green'  }
      case 2: return { label: t('sessions.status.inactive_pending'), cls: 'tag-yellow' }
      case 3: return { label: t('sessions.status.inactive'),         cls: 'tag-grey'   }
      default: return { label: `${t('table.status').toUpperCase()} ${s}`,     cls: 'tag-grey'   }
    }
  }

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await window.api.fetchSessions() as { success: boolean; sessions: ChainSession[]; error?: string }
      if (res.success) setSessions((res.sessions ?? []).filter(s => typeof s.id === 'number'))
      else setError(t('sessions.fetch_error'))
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [t])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const unsub = window.api.onWalletChanged(() => {
      console.log('[SessionPanel] Wallet changed, reloading sessions...')
      load()
    })
    return () => { unsub() }
  }, [load])

  async function doCancel(id: number) {
    setConfirmId(null); setCancelling(id)
    try {
      const res = await window.api.cancelSession(id) as { success: boolean; error?: string }
      if (res.success) setSessions(s => s.filter(x => x.id !== id))
      else setError(`${t('sessions.fetch_error')} #${id}: ${res.error}`)
    } finally { setCancelling(null) }
  }

  const sessionToEnd = sessions.find(s => s.id === confirmId)

  return (
    <div className="panel-container">
      {confirmId !== null && sessionToEnd && (
        <ConfirmModal
          title={t('sessions.end_confirm_title')} danger confirmLabel={t('sessions.end_btn')} cancelLabel={t('common.cancel')}
          onCancel={() => setConfirmId(null)} onConfirm={() => doCancel(confirmId)}
          message={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="confirm-session-card">
                <div className="cscard-row"><span>{t('sessions.id')}</span><strong style={{ color: 'var(--cyan)' }}>#{sessionToEnd.id}</strong></div>
                <div className="cscard-row"><span>{t('sessions.node')}</span><span style={{ fontSize: 10, color: 'var(--text-3)' }} title={sessionToEnd.nodeAddress}>{sessionToEnd.nodeAddress.slice(0, 22)}…</span></div>
                <div className="cscard-row"><span>{t('sessions.data_used')}</span><span>↓ {fmtBytes(sessionToEnd.downloadBytes)} · ↑ {fmtBytes(sessionToEnd.uploadBytes)}</span></div>
                <div className="cscard-row"><span>{t('sessions.duration')}</span><span>{fmtDuration(sessionToEnd.durationSecs)}</span></div>
                {sessionToEnd.price && <div className="cscard-row"><span>{t('sessions.price')}</span><span style={{ color: 'var(--yellow)' }}>{fmtPrice(sessionToEnd.price, sessionToEnd.maxDurationSecs > 0)}</span></div>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.6 }}>{t('sessions.msg_cancel_session_hint')}</div>
            </div>
          }
        />
      )}

      <div className="panel-header">
        <div>
          <div className="panel-title">{t('sessions.title')}</div>
          <div className="panel-sub">{t('sessions.sub', { active: sessions.filter(s => s.status === 1).length, inactive: sessions.filter(s => s.status !== 1).length })}</div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>{loading ? <><div className="spinner" style={{ width: 11, height: 11 }} /> {t('common.loading_simple')}</> : `↻ ${t('common.refresh')}`}</button>
      </div>

      {error && <div className="error-box"><div className="error-label">{t('common.error')}</div>{error}</div>}

      {loading && sessions.length === 0 ? (
        <div className="empty-state">
          <div className="spinner" style={{ width: 32, height: 32 }} />
          <div className="empty-state-text">{t('sessions.fetching')}</div>
        </div>
      ) : !loading && !error && sessions.length === 0 ? (
        <div className="empty-state"><div className="empty-state-icon">⬡</div><div className="empty-state-text">{t('sessions.no_sessions')}</div></div>
      ) : null}

      {sessions.length > 0 && (
        <div className="sessions-table-wrapper">
          <table className="sessions-table">
            <thead>
              <tr>
                <th>{t('sessions.id')}</th><th>{t('table.status')}</th><th>{t('sessions.node')}</th><th>{t('sessions.city')}</th><th>{t('sessions.usage_pct')}</th><th>{t('sessions.traffic')}</th><th>{t('sessions.quota')}</th><th>{t('sessions.duration')}</th><th>{t('sessions.price')}</th><th>{t('sessions.start')}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map(s => {
                const st = statusInfo(s.status); const busy = cancelling === s.id; const isHourly = s.maxDurationSecs > 0
                const node = nodes.find(n => n.address === s.nodeAddress)
                return (
                  <tr key={s.id}>
                    <td style={{ color: 'var(--cyan)', fontWeight: 700 }}>#{s.id}</td>
                    <td><span className={`tag ${st.cls}`}>{st.label}</span></td>
                    <td>
                      {node ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} title={node.moniker}>
                          <span>{countryToFlag(node.country)}</span>
                          <span style={{ fontWeight: 600, color: 'var(--text-1)', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {node.moniker}
                          </span>
                        </div>
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{s.nodeAddress.slice(0, 12)}…</span>
                      )}
                    </td>
                    <td style={{ fontSize: 10, color: 'var(--text-2)' }}>{node ? node.city : '—'}</td>
                    <td><UsageProgress session={s} /></td>
                    <td><BwMini dl={s.downloadBytes} ul={s.uploadBytes} /></td>
                    <td style={{ color: 'var(--text-2)', fontSize: 10 }}>{isHourly ? t('sessions.unlimited') : fmtBytes(s.maxBytes)}</td>
                    <td style={{ color: 'var(--text-2)', fontSize: 10 }}>{fmtDuration(s.durationSecs)}</td>
                    <td style={{ fontSize: 10, color: 'var(--yellow)', whiteSpace: 'nowrap' }}>{fmtPrice(s.price, isHourly)}</td>
                    <td style={{ fontSize: 10, color: 'var(--text-3)' }}>{fmtDate(s.startAt)}</td>
                    <td>
                      {s.status === 1 && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-danger btn-sm" disabled={busy || !!connecting} onClick={() => setConfirmId(s.id)}>{busy ? <div className="spinner" style={{ width: 10, height: 10 }} /> : `✕ ${t('sessions.end_btn')}`}</button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { WalletEntry, WalletInfo } from '../types'
import { formatBalance } from '../utils'
import ConfirmModal from './ConfirmModal'

interface Props {
  onSwitched: (address: string, label: string, rpc: string) => void
}

export default function WalletManager({ onSwitched }: Props) {
  const { t } = useTranslation()
  const [wallets,  setWallets]  = useState<WalletEntry[]>([])
  const [activeInfo, setActiveInfo] = useState<WalletInfo | null>(null)
  const [allBalances, setAllBalances] = useState<Record<string, any[]>>({})
  const [adding,   setAdding]   = useState(false)
  const [mnemonic, setMnemonic] = useState('')
  const [label,    setLabel]    = useState('')
  const [busy,     setBusy]     = useState<number | null>(null)
  const [error,    setError]    = useState<string | null>(null)
  const [editIdx,  setEditIdx]  = useState<number | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [removeIdx, setRemoveIdx] = useState<number | null>(null)

  const load = useCallback(async () => {
    setError(null)
    const list = await window.api.listWallets() as WalletEntry[]
    setWallets(list)
    
    const info = await window.api.getWalletInfo()
    if (info.success) setActiveInfo(info as WalletInfo)

    const addrs = list.map(w => w.address).filter(Boolean) as string[]
    if (addrs.length > 0) {
      const res = await window.api.getBalances(addrs)
      if (res.success) {
        const map: Record<string, any[]> = {}
        res.results.forEach((r: any) => { map[r.address] = r.balances })
        setAllBalances(map)
      }
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (mnemonic.trim().split(/\s+/).length < 12) { setError(t('wallet.mnemonic_error')); return }
    setBusy(-1)
    const res = await window.api.addWallet(mnemonic.trim(), label.trim() || `${t('wallet.label')} ${wallets.length + 1}`) as { success: boolean; address?: string; label?: string; rpc?: string; error?: string }
    setBusy(null)
    if (!res.success) { setError(res.error ?? 'Failed'); return }
    onSwitched(res.address!, res.label!, res.rpc!)
    setMnemonic(''); setLabel(''); setAdding(false)
    load()
  }

  async function handleSwitch(idx: number) {
    setBusy(idx)
    const res = await window.api.switchWallet(idx) as { success: boolean; address?: string; label?: string; rpc?: string; error?: string }
    setBusy(null)
    if (res.success) { onSwitched(res.address!, res.label!, res.rpc!); load() }
    else setError(res.error ?? 'Switch failed')
  }

  async function handleRemove(idx: number) {
    setRemoveIdx(idx)
  }

  async function doRemoveWallet() {
    if (removeIdx === null) return
    const idx = removeIdx
    setRemoveIdx(null)
    const res = await window.api.removeWallet(idx) as { success: boolean; error?: string }
    if (!res.success) { setError(res.error ?? 'Remove failed'); return }
    load()
  }

  async function handleRename(idx: number) {
    if (!editLabel.trim()) return
    await window.api.renameWallet(idx, editLabel.trim())
    setEditIdx(null); load()
  }

  return (
    <div className="panel-container">
      {removeIdx !== null && (
        <ConfirmModal
          title={t('wallet.remove_confirm_title')} danger confirmLabel={t('wallet.remove_confirm_btn')} cancelLabel={t('common.cancel')}
          onCancel={() => setRemoveIdx(null)} onConfirm={doRemoveWallet}
          message={t('wallet.remove_confirm_msg', { label: wallets.find(w => w.index === removeIdx)?.label })}
        />
      )}
      <div className="panel-header">
        <div>
          <div className="panel-title">{t('wallet.manage_title')}</div>
          <div className="panel-sub">{t('wallet.manage_sub')}</div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(v => !v)}>
          {adding ? `✕ ${t('common.cancel')}` : `+ ${t('wallet.add_wallet')}`}
        </button>
      </div>

      {error && <div className="error-box" style={{ marginBottom: 16 }}><div className="error-label">{t('common.error')}</div>{error}</div>}

      {adding && (
        <form onSubmit={handleAdd} className="wallet-add-form">
          <div className="form-group">
            <label className="form-label">{t('wallet.label')}</label>
            <input className="form-input" placeholder={t('wallet.label_placeholder')} value={label} onChange={e => setLabel(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('wallet.mnemonic_label')}</label>
            <textarea className="form-input textarea" placeholder={t('wallet.mnemonic_placeholder')} value={mnemonic} onChange={e => setMnemonic(e.target.value)} spellCheck={false} />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={busy === -1}>
            {busy === -1 ? <><div className="spinner" style={{ width: 13, height: 13 }} /> {t('common.adding')}</> : `⚡ ${t('wallet.add_switch')}`}
          </button>
        </form>
      )}

      <div className="wallet-list">
        {wallets.map(w => (
          <div key={w.index} className={`wallet-entry ${w.active ? 'active' : ''}`}>
            <div className="wallet-entry-icon">{w.active ? '▶' : '◇'}</div>
            <div className="wallet-entry-body">
              {editIdx === w.index ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    className="form-input" style={{ padding: '4px 8px', fontSize: 12 }}
                    value={editLabel}
                    onChange={e => setEditLabel(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleRename(w.index); if (e.key === 'Escape') setEditIdx(null) }}
                    autoFocus
                  />
                  <button className="btn btn-primary btn-sm" onClick={() => handleRename(w.index)}>✓</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditIdx(null)}>✕</button>
                </div>
              ) : (
                <div className="wallet-entry-label">
                  {w.label}
                  {w.active && <span style={{ color: 'var(--text-3)', fontSize: 10, marginLeft: 8, fontWeight: 'normal' }}>- {t('wallet.active_status')}</span>}
                </div>
              )}
              <div className="wallet-entry-sub" style={{ wordBreak: 'break-all', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
                {w.address || t('wallet.loading_address')}
              </div>
              
              {w.address && allBalances[w.address] && (
                <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                  {allBalances[w.address].map((b: any) => (
                    <span key={b.denom} className={`tag tag-sm ${w.active ? 'tag-cyan' : ''}`} style={{ fontSize: 8, opacity: w.active ? 1 : 0.7 }}>
                      {formatBalance(b.amount, b.denom)}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="wallet-entry-actions">
              {!w.active && (
                <button className="btn btn-primary btn-sm" disabled={busy === w.index} onClick={() => handleSwitch(w.index)}>
                  {busy === w.index ? <div className="spinner" style={{ width: 10, height: 10 }} /> : t('common.switch')}
                </button>
              )}
              <button className="btn btn-secondary btn-sm" onClick={() => { setEditIdx(w.index); setEditLabel(w.label) }}>✎</button>
              {wallets.length > 1 && (
                <button className="btn btn-danger btn-sm" onClick={() => handleRemove(w.index)}>🗑</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

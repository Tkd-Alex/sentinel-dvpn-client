import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { RpcEndpoint } from '../types'

interface Props {
  currentRpc: string
  onChanged:  (url: string) => void
}

export default function RpcSelector({ currentRpc, onChanged }: Props) {
  const { t } = useTranslation()
  const [open,  setOpen]  = useState(false)
  const [list,  setList]  = useState<RpcEndpoint[]>([])
  const [busy,  setBusy]  = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.api.getRpcList().then(r => setList(r as RpcEndpoint[]))
  }, [])

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  async function handleSelect(url: string) {
    if (url === currentRpc) { setOpen(false); return }
    setBusy(true)
    try {
      await window.api.setRpc(url)
      onChanged(url)
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }

  const current = list.find(r => r.url === currentRpc)

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="rpc-btn"
        onClick={() => setOpen(v => !v)}
        title={t('rpc.change_endpoint')}
        disabled={busy}
      >
        {busy
          ? <><div className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> {t('rpc.switching')}</>
          : <><span className="rpc-dot" />RPC: {current?.label ?? currentRpc.replace('https://', '').split(':')[0]}</>
        }
        <span style={{ marginLeft: 4, opacity: 0.5 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="rpc-dropdown">
          <div className="rpc-dropdown-header">{t('rpc.select_title')}</div>
          {list.map(r => (
            <button
              key={r.url}
              className={`rpc-option ${r.url === currentRpc ? 'active' : ''}`}
              onClick={() => handleSelect(r.url)}
            >
              <div className="rpc-option-label">
                {r.url === currentRpc && <span style={{ color: 'var(--green)', marginRight: 6 }}>▶</span>}
                {r.label}
              </div>
              <div className="rpc-option-meta">
                <span className="rpc-region">{r.region}</span>
                <span className="rpc-url">{r.url.replace('https://', '')}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

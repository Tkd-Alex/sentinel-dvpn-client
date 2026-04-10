import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  onSuccess: (address: string, rpc: string) => void
}

export default function WalletSetup({ onSuccess }: Props) {
  const { t } = useTranslation()
  const [mnemonic, setMnemonic] = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (mnemonic.trim().split(/\s+/).length < 12) {
      setError(t('wallet.mnemonic_error'))
      return
    }
    setLoading(true)
    try {
      const res = await window.api.setupWallet(mnemonic.trim())
      if (res.success) {
        onSuccess(res.address!, (res as { rpc?: string }).rpc ?? '')
      } else {
        setError(res.error ?? 'Unknown error')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="wallet-setup-screen">
      <div className="setup-card">
        <div className="setup-header">
          <div className="icon">🔐</div>
          <h1>{t('wallet.setup_title')}</h1>
          <p>{t('wallet.setup_sub')}</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">{t('wallet.mnemonic_label')}</label>
            <textarea
              className="form-input textarea"
              placeholder={t('wallet.mnemonic_placeholder')}
              value={mnemonic}
              onChange={e => setMnemonic(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              data-gramm="false"
            />
            <div className="form-hint">
              <span className="dot" />
              <span>{t('wallet.mnemonic_hint')}</span>
            </div>
          </div>

          {error && (
            <div className="error-box">
              <div className="error-label">{t('common.error')}</div>
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary btn-full"
            disabled={loading || !mnemonic.trim()}
          >
            {loading
              ? <><div className="spinner" style={{ width: 16, height: 16 }} /> {t('common.loading')}</>
              : `⚡ ${t('wallet.connect_btn')}`}
          </button>
        </form>

        <div className="divider">or</div>

        <p style={{ textAlign: 'center', fontSize: 10, color: 'var(--text-3)' }}>
          {t('wallet.setup_footer')}
        </p>
      </div>
    </div>
  )
}

import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { AppSettings } from '../types'

const DOH_OPTIONS = [
  { label: 'System Default (none)',  ip: null },
  { label: 'Cloudflare (1.1.1.1)',   ip: '1.1.1.1' },
  { label: 'Cloudflare WARP',        ip: '1.0.0.1' },
  { label: 'Google (8.8.8.8)',       ip: '8.8.8.8' },
  { label: 'Quad9 (9.9.9.9)',        ip: '9.9.9.9' },
  { label: 'NextDNS',                ip: '45.90.28.0' },
]

const LANG_OPTIONS = [
  { label: 'English', value: 'en' },
  { label: 'Italiano', value: 'it' },
  { label: 'Русский', value: 'ru' },
  { label: 'فارسی', value: 'fa' },
  { label: 'العربية', value: 'ar' },
  { label: '中文', value: 'zh' },
  { label: 'Español', value: 'es' },
  { label: 'Deutsch', value: 'de' },
  { label: 'Français', value: 'fr' },
]

interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  sub?: string
  warn?: string
  disabled?: boolean
}

function Toggle({ checked, onChange, label, sub, warn, disabled }: ToggleProps) {
  return (
    <div className={`setting-row ${disabled ? 'setting-row-disabled' : ''}`}>
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {sub && <div className="setting-sub">{sub}</div>}
        {warn && <div className="setting-warn">⚠ {warn}</div>}
      </div>
      <button
        className={`toggle-btn ${checked ? 'on' : 'off'}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  )
}

interface Props {
  currentRpc?: string
}

export default function SettingsPanel({ currentRpc }: Props) {
  const { t, i18n } = useTranslation()
  const [settings, setSettings] = useState<AppSettings>({
    killSwitch: false, autoReconnect: true,
    splitTunnel: false, splitRoutes: '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
    dohIp: null
  })
  const [saved,   setSaved]   = useState(false)
  const [ksError, setKsError] = useState<string | null>(null)

  useEffect(() => {
    window.api.getSettings().then(s => { if (s) setSettings(s as AppSettings) })
  }, [])

  async function save(patch: Partial<AppSettings>) {
    const next = { ...settings, ...patch }
    setSettings(next)
    await window.api.saveSettings(patch as Record<string, unknown>)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  async function toggleKillSwitch(on: boolean) {
    setKsError(null)
    const res = on
      ? await window.api.enableKillSwitch()
      : await window.api.disableKillSwitch()
    if ((res as { success: boolean }).success) save({ killSwitch: on })
    else setKsError((res as { error?: string }).error ?? 'Failed')
  }

  async function changeLanguage(lang: string) {
    await i18n.changeLanguage(lang)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="panel-container">
      <div className="panel-header">
        <div>
          <div className="panel-title">{t('settings.title')}</div>
          <div className="panel-sub">{t('settings.sub')}</div>
        </div>
        {saved && <span style={{ fontSize: 11, color: 'var(--green)' }}>✓ {t('common.save')}d</span>}
      </div>

      {/* ── Internationalization ── */}
      <div className="settings-section">
        <div className="settings-section-label">{t('settings.language')}</div>
        <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
          <div className="setting-text">
            <div className="setting-label">{t('settings.lang_label')}</div>
            <div className="setting-sub">{t('settings.lang_sub')}</div>
          </div>
          <select
            className="filter-select"
            style={{ minWidth: 260 }}
            value={i18n.language}
            onChange={e => changeLanguage(e.target.value)}
          >
            {LANG_OPTIONS.map(d => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Privacy & Protection ── */}
      <div className="settings-section">
        <div className="settings-section-label">{t('settings.privacy_title')}</div>

        <Toggle
          label={t('settings.kill_switch')}
          sub={t('settings.ks_sub')}
          warn={t('settings.ks_warn')}
          checked={settings.killSwitch}
          onChange={toggleKillSwitch}
        />
        {ksError && <div className="error-box" style={{ margin: '8px 0 0' }}><div className="error-label">{t('settings.kill_switch')} {t('common.error')}</div>{ksError}</div>}

        <Toggle
          label={t('settings.auto_reconnect')}
          sub={t('settings.ar_sub')}
          checked={settings.autoReconnect}
          onChange={v => save({ autoReconnect: v })}
        />
      </div>

      {/* ── DNS ── */}
      <div className="settings-section">
        <div className="settings-section-label">{t('settings.dns_title')}</div>
        <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
          <div className="setting-text">
            <div className="setting-label">{t('settings.dns_resolver')}</div>
            <div className="setting-sub">{t('settings.dns_sub')}</div>
          </div>
          <select
            className="filter-select"
            style={{ minWidth: 260 }}
            value={settings.dohIp ?? ''}
            onChange={e => save({ dohIp: e.target.value || null })}
          >
            {DOH_OPTIONS.map(d => (
              <option key={d.label} value={d.ip ?? ''}>{d.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Split Tunnel ── */}
      <div className="settings-section">
        <div className="settings-section-label">{t('settings.split_tunnel')}</div>

        <Toggle
          label={t('settings.st_enable')}
          sub={t('settings.st_sub')}
          checked={settings.splitTunnel}
          onChange={v => save({ splitTunnel: v })}
        />

        {settings.splitTunnel && (
          <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8, paddingTop: 0 }}>
            <div className="setting-label" style={{ fontSize: 10, color: 'var(--text-3)' }}>{t('settings.st_routes_label')}</div>
            <input
              className="form-input"
              style={{ width: '100%', fontSize: 11 }}
              value={settings.splitRoutes}
              placeholder="10.0.0.0/8,192.168.0.0/16"
              onChange={e => setSettings(s => ({ ...s, splitRoutes: e.target.value }))}
              onBlur={() => save({ splitRoutes: settings.splitRoutes })}
            />
            <div style={{ fontSize: 10, color: 'var(--text-3)', lineHeight: 1.6 }}>
              {t('settings.st_routes_hint')}
            </div>
          </div>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section-label">{t('settings.about_title')}</div>
        <div className="settings-about">
          <div>SDK: <strong>@sentinel-official/sentinel-js-sdk v2.0.4</strong></div>
          <div>Node list: <strong>api.sentnodes.com</strong></div>
          {/* <div>Chain: <strong>Sentinel Hub (Cosmos SDK)</strong></div> */}
          <div>RPC: <strong>{currentRpc || 'rpc.sentinel.co:443'}</strong></div>
          <div style={{ marginTop: 10, fontSize: 10, lineHeight: 1.8, color: 'var(--text-3)' }}>
            {t('settings.about_footer')}
          </div>
        </div>
      </div>
    </div>
  )
}

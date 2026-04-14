import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { BinaryStatus } from '../types'

interface InstallStep {
  id:      string // internal ID for filtering (debian, arch, fedora, suse)
  label:   string
  code:    string
  note?:   string
}

interface BinaryGuide {
  id:         string
  name:       string
  icon:       string
  found:      boolean
  path:       string | null
  hash:       string | null
  why:        string
  linux:      InstallStep[]
  macos:      InstallStep[]
  windows:    string   // URL
}

const GUIDES = (status: BinaryStatus, t: any): BinaryGuide[] => [
  {
    id:    'wireguard',
    name:  'WireGuard (wg-quick)',
    icon:  '⬡',
    found: status.wireguard,
    path:  status.wgPath,
    hash:  status.wgHash,
    why:   t('binary.why.wireguard'),
    linux: [
      { id: 'debian', label: 'Ubuntu / Debian', code: 'apt install -y wireguard-tools' },
      { id: 'fedora', label: 'Fedora / RHEL',   code: 'dnf install -y wireguard-tools' },
      { id: 'arch',   label: 'Arch Linux',      code: 'pacman -S --noconfirm wireguard-tools' },
      { id: 'suse',   label: 'openSUSE',        code: 'zypper install -y wireguard-tools' },
    ],
    macos:   [{ id: 'brew', label: 'Homebrew', code: 'brew install wireguard-tools' }],
    windows: 'https://www.wireguard.com/install/',
  },
  {
    id:    'v2ray',
    name:  'V2Ray',
    icon:  '▶',
    found: status.v2ray,
    path:  status.v2rayPath,
    hash:  status.v2rayHash,
    why:   t('binary.why.v2ray'),
    linux: [
      { id: 'debian', label: 'Official Script', code: 'curl -L https://raw.githubusercontent.com/v2fly/fhs-install-v2ray/master/install-release.sh | bash' },
      { id: 'fedora', label: 'Official Script', code: 'curl -L https://raw.githubusercontent.com/v2fly/fhs-install-v2ray/master/install-release.sh | bash' },
      { id: 'arch',   label: 'Arch Linux',      code: 'pacman -S --noconfirm v2ray' },
    ],
    macos:   [{ id: 'brew', label: 'Homebrew', code: 'brew install v2ray' }],
    windows: 'https://github.com/v2fly/v2ray-core/releases/latest',
  },
  {
    id:    'tun2socks',
    name:  'tun2socks',
    icon:  '🛡',
    found: status.tun2socks,
    path:  status.tun2socksPath,
    hash:  status.tun2socksHash,
    why:   t('binary.why.tun2socks'),
    linux: [
      { id: 'debian', label: 'Ubuntu / Debian', code: 'apt install -y tun2socks' },
      { id: 'arch',   label: 'Arch Linux (AUR)', code: 'yay -S --noconfirm tun2socks' },
      { id: 'fedora', label: 'Fedora / RHEL',   code: 'dnf install -y tun2socks' },
    ],
    macos:   [{ id: 'brew', label: 'Homebrew', code: 'brew install tun2socks' }],
    windows: 'https://github.com/xjasonlyu/tun2socks/releases',
  }
]

function ActionBtn({ code, onExec }: { code: string; onExec: (cmd: string) => void }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
        {copied ? '✓' : '📋'}
      </button>
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={async () => { setBusy(true); await onExec(code); setBusy(false) }}>
        {busy ? <div className="spinner" style={{ width: 10, height: 10 }} /> : `⚡ ${t('common.exec')}`}
      </button>
    </div>
  )
}

interface Props {
  status:    BinaryStatus
  onDismiss: () => void
  onRecheck: () => Promise<BinaryStatus>
}

export default function BinarySetup({ status, onDismiss, onRecheck }: Props) {
  const { t } = useTranslation()
  const [current, setCurrent]   = useState(status)
  const [checking, setChecking] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss() }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [onDismiss])

  async function handleRecheck() {
    setChecking(true); try { const fresh = await onRecheck(); setCurrent(fresh) } finally { setChecking(false) }
  }

  async function handleBrowse(id: string) {
    const name = id === 'wireguard' ? 'wireguard.exe' : id === 'v2ray' ? 'v2ray.exe' : 'tun2socks.exe'
    const res = await (window.api as any).browseBinary(name)
    if (res.success) {
      handleRecheck()
    }
  }

  async function handleExec(cmd: string) {
    const res = await (window.api as any).installBinary(cmd)
    if (res.success) {
      alert(t('binary.exec_success'))
      handleRecheck()
    } else {
      alert(`${t('common.error')}: ${res.error}`)
    }
  }

  const getFilteredSteps = (g: BinaryGuide) => {
    if (current.platform === 'darwin') return g.macos
    if (current.platform === 'win32') return []
    // Linux: strictly filter by detected distro
    const steps = g.linux.filter(s => s.id === current.distro)
    // If no specific match, show all linux steps as fallback
    return steps.length > 0 ? steps : g.linux
  }

  const guides = GUIDES(current, t).filter(g => !g.found)
  if (guides.length === 0) return null

  return (
    <div className="binary-check-overlay" onClick={e => e.target === e.currentTarget && onDismiss()}>
      <div className="binary-check-card" style={{ maxWidth: 700 }}>
        <button className="modal-close" style={{ position: 'absolute', top: 20, right: 20 }} onClick={onDismiss}>✕</button>

        <div className="binary-check-header">
          <div className="binary-check-icon">⚠</div>
          <div>
            <div className="binary-check-title">{t('binary.integrity_check')}</div>
            <div className="binary-check-sub">{t('binary.env_check', { distro: current.distro.toUpperCase() })}</div>
          </div>
        </div>

        <div className="binary-status-list">
          {GUIDES(current, t).map(g => (
            <div key={g.id} className={`binary-row ${g.found ? 'ok' : 'missing'}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="binary-icon" style={{ fontSize: 18 }}>{g.icon}</span>
                <div style={{ flex: 1 }}>
                  <div className="binary-name">{g.name}</div>
                  {g.found ? (
                    <div style={{ fontSize: 9, color: 'var(--text-3)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>
                      PATH: {g.path}<br/>HASH: {g.hash?.slice(0, 32)}…
                    </div>
                  ) : (
                    <div className="binary-path">{t('binary.not_found')}</div>
                  )}
                </div>
                <span className={`tag ${g.found ? 'tag-green' : 'tag-red'}`}>{g.found ? t('common.verified') : t('common.missing')}</span>
              </div>

              {!g.found && (
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <button className="btn btn-secondary btn-sm btn-full" onClick={() => setExpanded(expanded === g.id ? null : g.id)}>
                    {expanded === g.id ? `▲ ${t('binary.hide_guide')}` : `▼ ${t('binary.view_guide')}`}
                  </button>
                  {expanded === g.id && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.6 }}>
                        {g.why}
                        {g.id === 'tun2socks' && current.platform === 'win32' && (
                          <div style={{ marginTop: 8, color: 'var(--orange)', fontWeight: 600 }}>
                            ⚠ {t('binary.wintun_missing')}
                          </div>
                        )}
                      </div>
                      {current.platform === 'win32' ? (
                        <div style={{ display: 'flex', gap: 10 }}>
                          <a href={g.windows} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm" style={{ flex: 1, textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {t('binary.download_windows')}
                          </a>
                          <button className="btn btn-secondary btn-sm" style={{ flex: 1 }} onClick={() => handleBrowse(g.id)}>
                            📂 {t('common.browse')}
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {getFilteredSteps(g).map((step, i) => (
                            <div key={i} style={{ background: 'var(--bg-0)', padding: 10, borderRadius: 4, border: '1px solid var(--border)' }}>
                              <div style={{ fontSize: 9, color: 'var(--text-3)', marginBottom: 6, textTransform: 'uppercase' }}>{step.label}</div>
                              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                <code style={{ flex: 1, fontSize: 10, color: 'var(--cyan)' }}>{step.code}</code>
                                <ActionBtn code={step.code} onExec={handleExec} />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button className="btn btn-secondary btn-sm" disabled={checking} onClick={handleRecheck}>
            {checking ? t('common.checking') : `↻ ${t('filters.reset')}`}
          </button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={onDismiss}>{t('binary.ignore_continue')}</button>
        </div>
      </div>
    </div>
  )
}

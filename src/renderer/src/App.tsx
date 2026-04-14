import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import TitleBar           from './components/TitleBar'
import WalletSetup        from './components/WalletSetup'
import WalletBar          from './components/WalletBar'
import FiltersBar         from './components/FiltersBar'
import NodeTable          from './components/NodeTable'
import Globe              from './components/Globe'
import NodeConnectModal   from './components/NodeConnectModal'
import ConnectedBar       from './components/ConnectedBar'
import BinarySetup    from './components/BinarySetup'
import SessionPanel       from './components/SessionPanel'
import SettingsPanel      from './components/SettingsPanel'
import WalletManager      from './components/WalletManager'
import ConfirmModal       from './components/ConfirmModal'
import { ApiNode, NodeFilters, ConnectionState, BinaryStatus, INITIAL_CONNECTION } from './types'

type AppScreen = 'loading' | 'setup' | 'main'
type Tab       = 'globe' | 'nodes' | 'sessions' | 'manage'

const GLOBE_DEFAULTS: NodeFilters = {
  search: '', country: '', city: '', type: '',
  onlyActive: true, onlyHealthy: true, onlyWhitelisted: false,
  hideResidential: false, hideDuplicate: false, bookmarksOnly: false,
}
const TABLE_DEFAULTS: NodeFilters = {
  search: '', country: '', city: '', type: '',
  onlyActive: true, onlyHealthy: true, onlyWhitelisted: false,
  hideResidential: false, hideDuplicate: false, bookmarksOnly: false,
}

export default function App() {
  const { t, i18n } = useTranslation()
  const isRtl = i18n.language === 'ar' || i18n.language === 'fa'

  useEffect(() => {
    document.documentElement.dir = isRtl ? 'rtl' : 'ltr'
    document.documentElement.lang = i18n.language
  }, [i18n.language, isRtl])

  const [screen, setScreen]         = useState<AppScreen>('loading')
  const [currentRpc, setCurrentRpc] = useState('')
  const [activeTab, setActiveTab]   = useState<Tab>('globe')
  const [binaries, setBinaries]     = useState<BinaryStatus | null>(null)
  const [showBinaryCheck, setShowBinaryCheck] = useState(false)

  const [nodes, setNodes]               = useState<ApiNode[]>([])
  const [nodesLoading, setNodesLoading] = useState(false)
  const [nodesError, setNodesError]     = useState<string | null>(null)

  const [globeFilters, setGlobeFilters] = useState<NodeFilters>(GLOBE_DEFAULTS)
  const [tableFilters, setTableFilters] = useState<NodeFilters>(TABLE_DEFAULTS)

  const [bookmarks, setBookmarks] = useState<string[]>([])

  const [modalNode, setModalNode]           = useState<ApiNode | null>(null)
  const [modalInfoOnly, setModalInfoOnly]   = useState(false)
  const [reuseSessionId, setReuseSessionId] = useState<number | null>(null)
  
  const [showIpModal, setShowIpModal]           = useState(false)
  
  const [showQuitConfirm, setShowQuitConfirm]     = useState(false)
  const [showForgetConfirm, setShowForgetConfirm] = useState(false)
  const [showDnsRetryConfirm, setShowDnsRetryConfirm] = useState(false)
  const [quitting, setQuitting]                   = useState(false)

  const [vpnWarning, setVpnWarning]         = useState<string | null>(null)
  const [activeConnection, setActiveConnection] = useState<ConnectionState | null>(null)
  const [reconnectMsg, setReconnectMsg]     = useState<string | null>(null)
  const [ipInfo, setIpInfo]                 = useState<any>(null)

  const refreshIp = useCallback(async () => {
    console.log('[App] Refreshing public IP...')
    try {
      const res = await window.api.getPublicIp()
      console.log('[App] IP Refresh result:', res)
      setIpInfo(res)
    } catch (e) { 
      console.error('[App] Failed to refresh IP', e)
      setIpInfo({ error: String(e) })
    }
  }, [])

  const fetchNodes = useCallback(async () => {
    setNodesLoading(true); setNodesError(null)
    try {
      const res = await window.api.fetchNodes()
      if (res.success) setNodes(res.nodes as ApiNode[])
      else setNodesError((res as { error?: string }).error ?? 'Failed')
    } catch (e) { setNodesError(String(e)) }
    finally { setNodesLoading(false) }
  }, [])

  useEffect(() => {
    async function boot() {
      refreshIp()
      const rpc  = await window.api.getCurrentRpc() as string
      setCurrentRpc(rpc)
      const bins = await window.api.checkBinaries() as BinaryStatus
      setBinaries(bins)
      if (!bins.wireguard || !bins.v2ray || !bins.tun2socks) setShowBinaryCheck(true)
      const bms = await window.api.listBookmarks() as string[]
      setBookmarks(bms)
      const has = await window.api.hasMnemonic()
      if (has) {
        const res = await window.api.loadStoredWallet()
        if (res.success) { 
          setCurrentRpc((res as { rpc?: string }).rpc ?? rpc)
          setScreen('main')
          return 
        }
      }
      setScreen('setup')
    }
    boot()
  }, [refreshIp])

  useEffect(() => { if (screen === 'main') fetchNodes() }, [screen, fetchNodes])

  useEffect(() => {
    const u1 = window.api.onVpnStatus((d: any) => {
      if (d.status === 'connected' || d.step === 'connected') {
        // Se il main dice che siamo connessi, assicuriamoci che lo stato sia aggiornato
        setActiveConnection(prev => ({
          ...(prev || INITIAL_CONNECTION),
          step: 'connected',
          sessionId: d.sessionId || prev?.sessionId || null,
          node: d.node || prev?.node || null
        }))
      }
    })
    const u2 = window.api.onVpnDisconnect((d: any) => {
      const reason = d?.reason ?? 'Disconnected'
      if (reason === 'manual') {
        setReconnectMsg(null)
        setActiveConnection(null)
      } else {
        setReconnectMsg(`${reason} — attempting reconnect…`)
        setActiveConnection(null)
      }
      setTimeout(refreshIp, 1000)
    })
    const u3 = window.api.onReconnect((d: unknown) => {
      const ev = d as { status: string; attempt?: number; delay?: number }
      if (ev.status === 'connected') {
        setReconnectMsg(null)
        setTimeout(refreshIp, 2000)
      }
      else if (ev.status === 'failed')  setReconnectMsg('Auto-reconnect failed after 5 attempts.')
      else if (ev.status === 'reconnecting') setReconnectMsg(`Reconnecting… (attempt ${ev.attempt})`)
      else if (ev.status === 'waiting') setReconnectMsg(`Reconnecting in ${Math.round((ev.delay ?? 0) / 1000)}s…`)
    })
    const u4 = window.api.onVpnWarning((d: unknown) => {
      const w = (d as { message?: string }).message ?? 'VPN warning'
      setVpnWarning(w)
      setTimeout(() => setVpnWarning(null), 8000)
    })
    const u5 = window.api.onCloseRequest(() => setShowQuitConfirm(true))
    const u6 = window.api.onDnsRetryAsk(() => setShowDnsRetryConfirm(true))
    return () => { u1(); u2(); u3(); u4(); u5(); u6() }
  }, [refreshIp])

  function applyFilters(nodes: ApiNode[], f: NodeFilters, bms: string[]): ApiNode[] {
    return nodes.filter(n => {
      const q = f.search.toLowerCase()
      if (q) {
        const ok = (n.moniker ?? '').toLowerCase().includes(q)
          || (n.address ?? '').toLowerCase().includes(q)
          || (n.city    ?? '').toLowerCase().includes(q)
        if (!ok) return false
      }
      if (f.country         && n.country !== f.country)          return false
      if (f.city            && n.city    !== f.city)             return false
      if (f.type            && n.type    !== parseInt(f.type))   return false
      if (f.onlyActive      && !n.isActive)                      return false
      if (f.onlyHealthy     && !n.isHealthy)                     return false
      if (f.onlyWhitelisted && !n.isWhitelisted)                 return false
      if (f.hideResidential && n.isResidential)                  return false
      if (f.hideDuplicate   && n.isDuplicate)                    return false
      if (f.bookmarksOnly   && !bms.includes(n.address))         return false
      return true
    })
  }

  const globeNodes = useMemo(() => applyFilters(nodes, globeFilters, bookmarks), [nodes, globeFilters, bookmarks])
  const tableNodes = useMemo(() => applyFilters(nodes, tableFilters, bookmarks), [nodes, tableFilters, bookmarks])

  async function toggleBookmark(address: string) {
    const res = await window.api.toggleBookmark(address) as { bookmarks: string[] }
    setBookmarks(res.bookmarks)
  }

  async function handleForgetWallet() {
    setShowForgetConfirm(true)
  }

  async function doForgetWallet() {
    setShowForgetConfirm(false)
    await window.api.forgetWallet()
    setActiveConnection(null); setNodes([]); setScreen('setup')
  }

  async function handleDisconnect() {
    await window.api.disconnectNode()
    setActiveConnection(null); setReconnectMsg(null)
    setTimeout(refreshIp, 1000)
  }

  async function handleConnectSession(nodeAddr: string, sid: number) {
    let target = nodes.find(n => n.address === nodeAddr)
    if (!target) {
      try {
        const res = await window.api.fetchNodeInfo(nodeAddr)
        if (res.success) target = (res.info as any).result || res.info
      } catch (e) { console.error('Failed to fetch node info', e) }
    }
    if (!target) { alert(`Node not found: ${nodeAddr}`); return }
    setReuseSessionId(sid); setModalInfoOnly(false); setModalNode(target)
  }

  const tabs: Array<{ id: Tab; label: string; icon: string }> = [
    { id: 'globe',    label: t('tabs.globe'),    icon: '🌐' },
    { id: 'nodes',    label: t('tabs.nodes'),    icon: '⬡' },
    { id: 'sessions', label: t('tabs.sessions'), icon: '⬢' },
    { id: 'manage',   label: t('tabs.manage'),   icon: '⚙' },
  ]

  useEffect(() => {
    if (activeConnection?.step === 'connected') {
      window.api.startTraffic()
    } else if (!activeConnection) {
      window.api.stopTraffic()
    }
  }, [activeConnection])

  if (screen === 'loading') return (
    <div className="app-shell" dir={isRtl ? 'rtl' : 'ltr'}>
      <TitleBar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
        <div className="spinner" style={{ width: 36, height: 36 }} />
        <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.2em' }}>{t('common.loading')}</div>
      </div>
    </div>
  )

  if (screen === 'setup') return (
    <div className="app-shell" dir={isRtl ? 'rtl' : 'ltr'}>
      <TitleBar />
      <WalletSetup onSuccess={(_, rpc) => { setCurrentRpc(rpc); setScreen('main') }} />
    </div>
  )

  return (
    <div className="app-shell" dir={isRtl ? 'rtl' : 'ltr'}>
      <TitleBar 
        showRpc currentRpc={currentRpc} 
        onRpcChanged={url => { setCurrentRpc(url); fetchNodes() }} 
        ipInfo={ipInfo}
        onRefreshIp={refreshIp}
      />

      {showBinaryCheck && binaries && (
        <BinarySetup
          status={binaries}
          onDismiss={() => setShowBinaryCheck(false)}
          onRecheck={async () => {
            const b = await window.api.checkBinaries() as BinaryStatus
            setBinaries(b); return b
          }}
        />
      )}

      <div className="content-area">
        <div className="main-layout">
          <WalletBar onForget={handleForgetWallet} />

          <div className="tab-bar">
            {tabs.map(t => (
              <button key={t.id} className={`tab-btn ${activeTab === t.id ? 'active' : ''}`}
                onClick={() => setActiveTab(t.id)}>
                <span className="tab-icon">{t.icon}</span>{t.label}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            {binaries && (!binaries.wireguard || !binaries.v2rayPath) && (
              <button className="tab-btn" style={{ color: 'var(--yellow)' }}
                onClick={() => setShowBinaryCheck(true)}>⚠ {t('common.missing_deps')}</button>
            )}
          </div>

          <div className="tab-content">
            {activeTab === 'globe' && (
              <div className="globe-tab-layout">
                <Globe nodes={globeNodes} bookmarks={bookmarks}
                  onSelect={node => { setModalInfoOnly(false); setModalNode(node) }} />
                <div className="globe-sidebar">
                  <div className="globe-sidebar-header">{t('filters.title')}</div>
                  <input className="form-input" style={{ fontSize: 11, padding: '6px 10px', marginBottom: 10 }}
                    placeholder={t('common.search')} value={globeFilters.search}
                    onChange={e => setGlobeFilters(f => ({ ...f, search: e.target.value }))} />
                  {([
                    ['onlyActive',      `● ${t('filters.only_active')}`],
                    ['onlyHealthy',     `♥ ${t('filters.only_healthy')}`],
                    ['bookmarksOnly',   `★ ${t('filters.bookmarks_only')}`],
                    ['hideResidential', `⌂ ${t('filters.hide_residential')}`],
                  ] as [keyof NodeFilters, string][]).map(([key, label]) => (
                    <label key={key} className="globe-filter-check">
                      <input type="checkbox" checked={!!globeFilters[key]}
                        onChange={e => setGlobeFilters(f => ({ ...f, [key]: e.target.checked }))} />
                      {label}
                    </label>
                  ))}
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 9, color: 'var(--text-3)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>{t('filters.type')}</div>
                    <select className="filter-select" style={{ width: '100%' }}
                      value={globeFilters.type}
                      onChange={e => setGlobeFilters(f => ({ ...f, type: e.target.value as NodeFilters['type'] }))}>
                      <option value="">{t('filters.all')}</option>
                      <option value="1">{t('filters.wireguard')}</option>
                      <option value="2">{t('filters.v2ray')}</option>
                    </select>
                  </div>
                  <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }}
                    onClick={() => setGlobeFilters(GLOBE_DEFAULTS)}>↺ {t('filters.reset')}</button>
                </div>
              </div>
            )}

            {activeTab === 'nodes' && (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
                <FiltersBar filters={tableFilters} onChange={setTableFilters} nodes={nodes} filteredCount={tableNodes.length} />
                {nodesLoading && nodes.length === 0
                  ? <div className="empty-state"><div className="spinner" style={{ width: 32, height: 32 }} /><div className="empty-state-text">Fetching nodes…</div></div>
                  : nodesError
                    ? <div className="empty-state"><div className="empty-state-icon">⚠</div><div className="empty-state-text" style={{ color: 'var(--red)' }}>{nodesError}</div><button className="btn btn-secondary btn-sm" onClick={fetchNodes}>Retry</button></div>
                    : <NodeTable nodes={tableNodes} onSelect={node => { 
                        const isConnected = activeConnection?.node?.address === node.address;
                        setModalInfoOnly(isConnected); 
                        setModalNode(node); 
                      }}
                        activeNodeAddress={activeConnection?.node?.address}
                        bookmarks={bookmarks} onToggleBookmark={toggleBookmark} />
                }
              </div>
            )}

            {activeTab === 'sessions' && <SessionPanel nodes={nodes} onConnectSession={handleConnectSession} />}

            {activeTab === 'manage' && (
              <div className="manage-tab-layout">
                <div className="manage-sidebar">
                  <WalletManager onSwitched={(_, __, rpc) => { 
                    setCurrentRpc(rpc); 
                    fetchNodes();
                    setTimeout(refreshIp, 1000);
                  }} />
                  
                  <div className="manage-binaries-section">
                    <div className="settings-section-label" style={{ marginBottom: 12 }}>{t('settings.binaries_title')}</div>
                    {binaries ? (
                      <BinarySetup
                        status={binaries}
                        onRecheck={async () => {
                          const fresh = await window.api.checkBinaries() as BinaryStatus
                          setBinaries(fresh)
                          return fresh
                        }}
                        embedded
                      />
                    ) : (
                      <div className="spinner" style={{ width: 20, height: 20, margin: '20px auto' }} />
                    )}
                  </div>
                </div>
                
                <div className="manage-main">
                  <SettingsPanel currentRpc={currentRpc} />
                </div>
              </div>
            )}
          </div>

          <div className="bottom-bar">
            <button className="btn btn-secondary btn-sm" onClick={fetchNodes} disabled={nodesLoading}>
              {nodesLoading ? <><div className="spinner" style={{ width: 10, height: 10 }} /> {t('common.fetching_nodes')}</> : `↻ ${t('common.refresh')}`}
            </button>
            <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{nodes.length} {t('common.nodes')}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{(currentRpc || '').replace('https://', '').split(':')[0]}</span>
          </div>

          {(activeConnection?.step === 'connected' || reconnectMsg) && (
            <ConnectedBar
              connection={activeConnection ?? { step: 'connected', node: null, subscriptionType: 'gigabytes', amount: 0, sessionId: null, vpnType: null, configStr: null, wgQrCode: null, shareLinks: [], v2rayQrCodes: [], inbounds: null, error: null }}
              reconnectMsg={reconnectMsg} onDisconnect={handleDisconnect}
              onManage={() => { if (activeConnection?.node) { setModalInfoOnly(true); setModalNode(activeConnection.node) } }}
            />
          )}
        </div>
      </div>

      {modalNode && (
        <NodeConnectModal
          node={modalNode} bookmarked={bookmarks.includes(modalNode.address)}
          onBookmark={() => toggleBookmark(modalNode.address)}
          onClose={() => { setModalNode(null); setModalInfoOnly(false); setReuseSessionId(null) }}
          onConnected={state => { 
            setActiveConnection(state); setModalNode(null); setModalInfoOnly(false); setReuseSessionId(null)
            setTimeout(refreshIp, 2000)
          }}
          infoOnly={modalInfoOnly} initialSessionId={reuseSessionId ? reuseSessionId.toString() : null}
        />
      )}

      {showForgetConfirm && (
        <ConfirmModal
          title={t('wallet.forget_confirm_title')} danger confirmLabel={t('wallet.forget_confirm_btn')} cancelLabel={t('common.cancel')}
          onCancel={() => setShowForgetConfirm(false)} onConfirm={doForgetWallet}
          message={t('wallet.forget_confirm_msg')}
        />
      )}

      {showQuitConfirm && (
        <ConfirmModal
          title={quitting ? t('modals.quit.title_quitting') : t('modals.quit.title_active')} 
          danger confirmLabel={quitting ? "" : t('modals.quit.confirm_quit')} cancelLabel={quitting ? "" : t('common.cancel')}
          onCancel={() => !quitting && setShowQuitConfirm(false)} 
          onConfirm={async () => { setQuitting(true); await window.api.quitApp(true) }}
          message={
            quitting ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, padding: '20px 0' }}>
                <div className="spinner" style={{ width: 32, height: 32 }} />
                <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.1em', textAlign: 'center' }}>
                  {t('modals.quit.terminating_on_chain')}<br/>
                  <span style={{ fontSize: 9, opacity: 0.7, marginTop: 8, display: 'block' }}>
                    {t('modals.quit.password_warning')}
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <p style={{ color: 'var(--text-2)' }}>{t('modals.quit.message')}</p>
                <button className="btn btn-secondary btn-full" onClick={async () => { await window.api.quitApp(false) }}>{t('modals.quit.quit_only')}</button>
              </div>
            )
          }
        />
      )}

      {showDnsRetryConfirm && (
        <ConfirmModal
          title={t('modals.dns.title')} confirmLabel={t('modals.dns.confirm')} cancelLabel={t('common.cancel')}
          onCancel={() => setShowDnsRetryConfirm(false)}
          onConfirm={() => { setShowDnsRetryConfirm(false); window.api.approveDnsRetry() }}
          message={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ color: 'var(--text-2)' }}>{t('modals.dns.message')}</p>
              <p style={{ color: 'var(--yellow)', fontWeight: 600 }}>{t('modals.dns.retrying_msg')}</p>
            </div>
          }
        />
      )}

      {vpnWarning && (
        <div className="vpn-toast" onClick={() => setVpnWarning(null)}>
          <span>⚠ {vpnWarning}</span><span className="vpn-toast-close">✕</span>
        </div>
      )}
    </div>
  )
}

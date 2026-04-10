import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiNode } from '../types'
import { countryToFlag, vpnTypeLabel, formatUdvpnPrice } from '../utils'

type SortKey = 'moniker' | 'country' | 'city' | 'type' | 'sessions' | 'peers' | 'gigaPrice' | 'hourPrice'
type SortDir = 'asc' | 'desc'

interface Props {
  nodes: ApiNode[]
  onSelect: (node: ApiNode) => void
  activeNodeAddress?: string | null
  bookmarks: string[]
  onToggleBookmark: (address: string) => void
}

export default function NodeTable({ nodes, onSelect, activeNodeAddress, bookmarks, onToggleBookmark }: Props) {
  const { t } = useTranslation()
  const [sortKey, setSortKey] = useState<SortKey>('sessions')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  function thCls(key: SortKey) {
    if (sortKey !== key) return ''
    return sortDir === 'asc' ? 'sort-asc' : 'sort-desc'
  }

  function udvpn(prices: Array<{ denom: string; value: string }>): number {
    const p = prices.find(x => x.denom === 'udvpn')
    return p ? parseInt(p.value, 10) : Infinity
  }

  const sorted = useMemo(() => [...nodes].sort((a, b) => {
    let av: string | number = 0, bv: string | number = 0
    switch (sortKey) {
      case 'moniker':   av = (a.moniker ?? '').toLowerCase(); bv = (b.moniker ?? '').toLowerCase(); break
      case 'country':   av = (a.country ?? '').toLowerCase(); bv = (b.country ?? '').toLowerCase(); break
      case 'city':      av = (a.city ?? '').toLowerCase();    bv = (b.city ?? '').toLowerCase();    break
      case 'type':      av = a.type;    bv = b.type;    break
      case 'sessions':  av = a.sessions; bv = b.sessions; break
      case 'peers':     av = a.peers;    bv = b.peers;    break
      case 'gigaPrice': av = udvpn(a.gigabytePrices); bv = udvpn(b.gigabytePrices); break
      case 'hourPrice': av = udvpn(a.hourlyPrices);   bv = udvpn(b.hourlyPrices);   break
    }
    if (av < bv) return sortDir === 'asc' ? -1 : 1
    if (av > bv) return sortDir === 'asc' ? 1 : -1
    return 0
  }), [nodes, sortKey, sortDir])

  if (!nodes.length) return (
    <div className="empty-state">
      <div className="empty-state-icon">◎</div>
      <div className="empty-state-text">{t('table.no_nodes')}</div>
    </div>
  )

  return (
    <div className="nodes-table-wrapper">
      <table className="nodes-table">
        <thead>
          <tr>
            <th style={{ width: 32 }} title={t('table.bookmark')}>☆</th>
            <th className={thCls('moniker')} onClick={() => handleSort('moniker')}>{t('table.node')}</th>
            <th className={thCls('country')} onClick={() => handleSort('country')}>{t('table.location')}</th>
            <th className={thCls('city')} onClick={() => handleSort('city')}>{t('table.city')}</th>
            <th className={thCls('type')} onClick={() => handleSort('type')}>{t('table.type')}</th>
            <th>{t('table.status')}</th>
            <th className={thCls('sessions')} onClick={() => handleSort('sessions')}>{t('table.sessions')}</th>
            <th className={thCls('peers')} onClick={() => handleSort('peers')}>{t('table.peers')}</th>
            <th className={thCls('gigaPrice')} onClick={() => handleSort('gigaPrice')}>{t('table.gb_price')}</th>
            <th className={thCls('hourPrice')} onClick={() => handleSort('hourPrice')}>{t('table.hr_price')}</th>
            <th>{t('table.flags')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(node => {
            const isActive   = node.address === activeNodeAddress
            const isBookmark = bookmarks.includes(node.address)
            return (
              <tr key={node.address} onClick={() => onSelect(node)}
                style={isActive ? { background: 'rgba(0,255,159,0.04)', outline: '1px solid rgba(0,255,159,0.2)' } : {}}>

                <td onClick={e => { e.stopPropagation(); onToggleBookmark(node.address) }}
                  style={{ textAlign: 'center', fontSize: 15, cursor: 'pointer', color: isBookmark ? 'var(--yellow)' : 'var(--text-3)' }}
                  title={isBookmark ? t('table.remove_bookmark') : t('table.bookmark')}>
                  {isBookmark ? '★' : '☆'}
                </td>

                <td className="td-moniker" title={`${node.address}\n${node.api}`}>
                  {isActive && <span style={{ color: 'var(--green)', marginRight: 6 }}>▶</span>}
                  {node.moniker}
                  <div style={{ fontSize: 9, color: 'var(--text-3)', marginTop: 2 }}>v{node.version}</div>
                </td>

                <td><div className="td-country">
                  <span className="td-flag">{countryToFlag(node.country ?? '')}</span>
                  <span className="td-country-name" title={node.country}>{node.country}</span>
                </div></td>

                <td style={{ color: 'var(--text-3)' }}>{node.city || '—'}</td>

                <td><span className={`td-type ${node.type === 1 ? 'wireguard' : 'v2ray'}`}>{vpnTypeLabel(node.type)}</span></td>

                <td>
                  <span className={`status-dot ${node.isActive ? 'active' : 'bad'}`} title={node.isActive ? t('table.active_status') : t('table.inactive_status')} />
                  <span style={{ 
                    fontSize: 12, 
                    marginLeft: 4, 
                    color: node.isHealthy ? 'var(--cyan)' : 'var(--red)', 
                    filter: `drop-shadow(0 0 3px ${node.isHealthy ? 'var(--cyan)' : 'var(--red)'})` 
                  }} title={node.isHealthy ? t('table.healthy_status') : t('table.unhealthy_status')}>
                    {node.isHealthy ? '♥' : '✗'}
                  </span>
                </td>

                <td style={{ color: node.sessions > 0 ? 'var(--cyan)' : 'var(--text-3)' }}>{node.sessions}</td>
                <td style={{ color: node.peers > 0 ? 'var(--text-2)' : 'var(--text-3)' }}>{node.peers}</td>
                <td style={{ color: 'var(--yellow)' }}>{formatUdvpnPrice(node.gigabytePrices)}</td>
                <td style={{ color: 'var(--orange)' }}>{formatUdvpnPrice(node.hourlyPrices)}</td>

                <td><div style={{ display: 'flex', gap: 4 }}>
                  {node.isWhitelisted && <span className="tag tag-green">✓</span>}
                  {node.isResidential && <span className="tag tag-cyan" title={t('common.residential')}>⌂</span>}
                  {node.isDuplicate   && <span className="tag tag-yellow" title={t('common.duplicate')}>⧉</span>}
                  {node.errorMessage  && <span className="tag tag-red" title={node.errorMessage ?? ''}>!</span>}
                </div></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

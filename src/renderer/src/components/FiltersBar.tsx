import React from 'react'
import { useTranslation } from 'react-i18next'
import { NodeFilters, ApiNode } from '../types'
import { uniqueSorted } from '../utils'

interface Props {
  filters: NodeFilters
  onChange: (f: NodeFilters) => void
  nodes: ApiNode[]
  filteredCount: number
}

export default function FiltersBar({ filters, onChange, nodes, filteredCount }: Props) {
  const { t } = useTranslation()
  const countries = uniqueSorted(nodes.map(n => n.country ?? '').filter(Boolean))
  const cities    = uniqueSorted(
    nodes.filter(n => !filters.country || n.country === filters.country).map(n => n.city ?? '').filter(Boolean)
  )
  const set = (patch: Partial<NodeFilters>) => onChange({ ...filters, ...patch })

  return (
    <div className="filters-bar">
      <div className="filter-search">
        <input
          className="form-input"
          style={{ width: '100%', padding: '6px 10px', fontSize: 11 }}
          placeholder={`🔍  ${t('filters.search_placeholder')}`}
          value={filters.search}
          onChange={e => set({ search: e.target.value })}
        />
      </div>

      <select className="filter-select" value={filters.country}
        onChange={e => set({ country: e.target.value, city: '' })}>
        <option value="">🌐 {t('filters.all_countries')}</option>
        {countries.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      <select className="filter-select" value={filters.city}
        onChange={e => set({ city: e.target.value })} disabled={!filters.country}>
        <option value="">{t('filters.all_cities')}</option>
        {cities.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      <select className="filter-select" value={filters.type}
        onChange={e => set({ type: e.target.value as NodeFilters['type'] })}>
        <option value="">{t('filters.all_types')}</option>
        <option value="1">{t('filters.wireguard')}</option>
        <option value="2">{t('filters.v2ray')}</option>
      </select>

      <button className={`filter-toggle ${filters.onlyActive      ? 'active' : ''}`} onClick={() => set({ onlyActive:      !filters.onlyActive      })}>● {t('filters.active')}</button>
      <button className={`filter-toggle ${filters.onlyHealthy     ? 'active' : ''}`} onClick={() => set({ onlyHealthy:     !filters.onlyHealthy     })}>♥ {t('filters.healthy_label')}</button>
      <button className={`filter-toggle ${filters.onlyWhitelisted ? 'active' : ''}`} onClick={() => set({ onlyWhitelisted: !filters.onlyWhitelisted })}>✓ {t('filters.listed')}</button>
      <button className={`filter-toggle ${filters.hideResidential ? 'active' : ''}`} onClick={() => set({ hideResidential: !filters.hideResidential })}>⌂ {t('filters.hide_res')}</button>
      <button className={`filter-toggle ${filters.hideDuplicate   ? 'active' : ''}`} onClick={() => set({ hideDuplicate:   !filters.hideDuplicate   })}>⧉ {t('filters.hide_dupes')}</button>
      <button className={`filter-toggle ${filters.bookmarksOnly   ? 'active' : ''}`} onClick={() => set({ bookmarksOnly:   !filters.bookmarksOnly   })}>★ {t('common.bookmarks')}</button>

      <div className="filters-count">{filteredCount} / {nodes.length} {t('common.nodes')}</div>
    </div>
  )
}

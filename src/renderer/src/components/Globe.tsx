import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import * as d3geo from 'd3-geo'
import { feature } from 'topojson-client'
import { ApiNode } from '../types'
import { countryToFlag, vpnTypeLabel } from '../utils'

// Country name → [lon, lat]
const COUNTRY_COORDS: Record<string, [number, number]> = {
  'United States': [-98, 39], 'Canada': [-96, 56], 'Mexico': [-102, 24],
  'Brazil': [-51, -14], 'Argentina': [-65, -34], 'Chile': [-71, -36],
  'Colombia': [-74, 4], 'Peru': [-76, -10], 'Venezuela': [-66, 8],
  'Ecuador': [-78, -2], 'Uruguay': [-56, -33], 'Bolivia': [-65, -17],
  'Cuba': [-80, 22], 'Dominican Republic': [-70, 19], 'Costa Rica': [-84, 10],
  'Guatemala': [-90, 15], 'Panama': [-80, 9], 'Puerto Rico': [-66, 18],
  'United Kingdom': [-3, 55], 'Germany': [10, 51], 'France': [2, 46],
  'Netherlands': [5, 52], 'Sweden': [15, 62], 'Norway': [8, 62],
  'Finland': [26, 64], 'Switzerland': [8, 47], 'Austria': [14, 47],
  'Belgium': [4, 51], 'Spain': [-4, 40], 'Italy': [12, 42],
  'Portugal': [-8, 39], 'Poland': [20, 52], 'Czech Republic': [15, 50],
  'Romania': [25, 46], 'Hungary': [19, 47], 'Bulgaria': [25, 43],
  'Ukraine': [32, 49], 'Russia': [105, 61], 'Turkey': [35, 39],
  'Greece': [22, 39], 'Denmark': [10, 56], 'Croatia': [16, 45],
  'Serbia': [21, 44], 'Slovakia': [19, 49], 'Lithuania': [24, 56],
  'Latvia': [25, 57], 'Estonia': [25, 59], 'Moldova': [29, 47],
  'Belarus': [28, 53], 'Iceland': [-18, 65], 'Ireland': [-8, 53],
  'Luxembourg': [6, 50], 'Malta': [14, 36], 'Cyprus': [33, 35], 'Slovenia': [15, 46],
  'Japan': [138, 36], 'South Korea': [128, 36], 'China': [104, 35],
  'India': [79, 21], 'Singapore': [104, 1], 'Hong Kong': [114, 22],
  'Taiwan': [121, 24], 'Thailand': [101, 15], 'Vietnam': [106, 16],
  'Indonesia': [118, -5], 'Malaysia': [112, 3], 'Philippines': [122, 13],
  'Pakistan': [70, 30], 'Bangladesh': [90, 24], 'Myanmar': [96, 20],
  'Mongolia': [105, 47], 'Iran': [53, 33], 'Iraq': [44, 33],
  'Israel': [35, 31], 'United Arab Emirates': [54, 24], 'Saudi Arabia': [45, 24],
  'Jordan': [37, 31], 'Kuwait': [48, 29], 'Qatar': [51, 25], 'Lebanon': [35, 34],
  'Australia': [134, -25], 'New Zealand': [174, -41],
  'South Africa': [25, -29], 'Nigeria': [8, 10], 'Kenya': [38, 1],
  'Egypt': [30, 27], 'Morocco': [-7, 32], 'Algeria': [3, 28],
  'Tunisia': [9, 34], 'Ghana': [-1, 8], 'Tanzania': [35, -6],
  'Ethiopia': [40, 9], 'Kazakhstan': [67, 48], 'Georgia': [44, 42],
  'Armenia': [45, 40], 'Azerbaijan': [48, 40],
}

interface Props {
  nodes:     ApiNode[]
  bookmarks: string[]
  onSelect:  (node: ApiNode) => void
}

export default function Globe({ nodes, bookmarks, onSelect }: Props) {
  const { t } = useTranslation()
  const canvasRef     = useRef<HTMLCanvasElement>(null)
  const containerRef  = useRef<HTMLDivElement>(null)
  const topoRef       = useRef<unknown>(null)
  const animRef       = useRef<number>(0)

  // Rotation state
  const rotRef        = useRef<[number, number]>([10, -20])
  // Zoom: scale multiplier on top of base radius
  const zoomRef       = useRef<number>(1)
  // Drag state
  const dragRef       = useRef<{ x: number; y: number; lambda: number; phi: number } | null>(null)
  const wasDragging   = useRef(false)
  const autoRotRef    = useRef(true)

  const [hovered, setHovered]   = useState<ApiNode | null>(null)
  const [tooltip, setTooltip]   = useState<{ x: number; y: number } | null>(null)
  const [size, setSize]         = useState({ w: 600, h: 600 })
  const [worldLoaded, setWorldLoaded] = useState(false)

  // Load world atlas once
  useEffect(() => {
    import('world-atlas/countries-110m.json').then(mod => {
      topoRef.current = mod.default
      setWorldLoaded(true)
    })
  }, [])

  // Responsive canvas size
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      const s = Math.min(width - 8, height - 8, 680)
      setSize({ w: s, h: s })
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // Memoize pins
  const pins = useMemo(() =>
    nodes.map(n => {
      const c = COUNTRY_COORDS[n.country ?? '']
      if (!c) return null
      return { node: n, lon: c[0], lat: c[1] }
    }).filter(Boolean) as Array<{ node: ApiNode; lon: number; lat: number }>,
    [nodes]
  )

  // Build projection from current state
  const makeProj = useCallback((w: number, h: number) => {
    const baseR = Math.min(w, h) / 2 - 12
    return d3geo.geoOrthographic()
      .scale(baseR * zoomRef.current)
      .translate([w / 2, h / 2])
      .rotate(rotRef.current)
      .clipAngle(90)
  }, [])

  // Hit-test: canvas pixel → ApiNode | null
  const getNodeAt = useCallback((cx: number, cy: number): ApiNode | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect  = canvas.getBoundingClientRect()
    const mx    = (cx - rect.left)  * (canvas.width  / rect.width)
    const my    = (cy - rect.top)   * (canvas.height / rect.height)
    const proj  = makeProj(canvas.width, canvas.height)
    let best: ApiNode | null = null
    let bestDist = 16  // px threshold

    for (const pin of pins) {
      const pt = proj([pin.lon, pin.lat])
      if (!pt) continue
      const dist = Math.hypot(pt[0] - mx, pt[1] - my)
      if (dist < bestDist) { bestDist = dist; best = pin.node }
    }
    return best
  }, [pins, makeProj])

  // Draw
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const topo   = topoRef.current
    if (!canvas || !topo) return

    const ctx   = canvas.getContext('2d')!
    const { width: w, height: h } = canvas
    const proj  = makeProj(w, h)
    const path  = d3geo.geoPath(proj, ctx)
    const baseR = Math.min(w, h) / 2 - 12
    const r     = baseR * zoomRef.current

    ctx.clearRect(0, 0, w, h)

    // Outer atmosphere glow
    const atm = ctx.createRadialGradient(w/2, h/2, r * 0.88, w/2, h/2, r * 1.12)
    atm.addColorStop(0, 'rgba(0,229,255,0.07)')
    atm.addColorStop(1, 'rgba(0,229,255,0)')
    ctx.beginPath(); ctx.arc(w/2, h/2, r * 1.12, 0, Math.PI*2)
    ctx.fillStyle = atm; ctx.fill()

    // Ocean
    ctx.beginPath()
    path({ type: 'Sphere' } as d3geo.GeoPermissibleObjects)
    const ocean = ctx.createRadialGradient(w/2 - r*0.2, h/2 - r*0.2, 0, w/2, h/2, r)
    ocean.addColorStop(0, '#0e1d35')
    ocean.addColorStop(1, '#060810')
    ctx.fillStyle = ocean; ctx.fill()

    // Graticule
    ctx.beginPath()
    path(d3geo.geoGraticule()())
    ctx.strokeStyle = 'rgba(0,229,255,0.045)'; ctx.lineWidth = 0.5; ctx.stroke()

    // Land
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const land = feature(topo as any, (topo as any).objects.countries)
    ctx.beginPath()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    path(land as any)
    ctx.fillStyle = '#0d1f3c'; ctx.fill()
    ctx.strokeStyle = 'rgba(0,229,255,0.18)'; ctx.lineWidth = 0.5; ctx.stroke()

    // Globe border
    ctx.beginPath()
    path({ type: 'Sphere' } as d3geo.GeoPermissibleObjects)
    ctx.strokeStyle = 'rgba(0,229,255,0.35)'; ctx.lineWidth = 1.5; ctx.stroke()

    // Pins
    for (const pin of pins) {
      const pt = proj([pin.lon, pin.lat])
      if (!pt) continue
      const [px, py] = pt
      // Cull pins behind the globe
      const dx = px - w/2, dy = py - h/2
      if (dx*dx + dy*dy > r*r * 1.01) continue

      const isBookmark = bookmarks.includes(pin.node.address)
      const isHovered  = hovered?.address === pin.node.address
      const isHealthy  = pin.node.isHealthy && pin.node.isActive
      const isWg       = pin.node.type === 1

      const color = isBookmark ? '#facc15'
        : isHovered           ? '#ffffff'
        : isHealthy           ? (isWg ? '#a855f7' : '#34d399')
        : '#ef4444'

      const radius = isHovered ? 8 : isBookmark ? 7 : 4.5

      // Pulse ring for hovered / bookmarked
      if (isHovered || isBookmark) {
        const t = Date.now() % 2000 / 2000
        const pulseR = radius + 4 + t * 8
        const alpha  = (1 - t) * 0.5
        ctx.beginPath()
        ctx.arc(px, py, pulseR, 0, Math.PI * 2)
        ctx.strokeStyle = color + Math.round(alpha * 255).toString(16).padStart(2, '0')
        ctx.lineWidth = 1; ctx.stroke()
      }

      // Glow halo
      const glow = ctx.createRadialGradient(px, py, 0, px, py, radius + 6)
      glow.addColorStop(0, color + '50')
      glow.addColorStop(1, color + '00')
      ctx.beginPath(); ctx.arc(px, py, radius + 6, 0, Math.PI*2)
      ctx.fillStyle = glow; ctx.fill()

      // Pin dot
      ctx.beginPath(); ctx.arc(px, py, radius, 0, Math.PI*2)
      ctx.fillStyle = color; ctx.fill()
      ctx.strokeStyle = '#060810'; ctx.lineWidth = 1.2; ctx.stroke()
    }

    // Zoom indicator
    if (zoomRef.current !== 1) {
      ctx.fillStyle = 'rgba(0,229,255,0.5)'
      ctx.font = '10px monospace'
      ctx.fillText(`${zoomRef.current.toFixed(1)}×`, 12, h - 12)
    }
  }, [pins, hovered, bookmarks, makeProj])

  // Animation loop
  useEffect(() => {
    if (!worldLoaded) return
    let last = performance.now()
    const loop = (ts: number) => {
      const dt = ts - last; last = ts
      if (autoRotRef.current && !dragRef.current) {
        rotRef.current = [rotRef.current[0] + dt * 0.006, rotRef.current[1]]
      }
      draw()
      animRef.current = requestAnimationFrame(loop)
    }
    animRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(animRef.current)
  }, [worldLoaded, draw])

  // ── Event handlers ──────────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    wasDragging.current = false
    dragRef.current = {
      x: e.clientX, y: e.clientY,
      lambda: rotRef.current[0], phi: rotRef.current[1]
    }
    autoRotRef.current = false
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.x
      const dy = e.clientY - dragRef.current.y
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) wasDragging.current = true
      rotRef.current = [
        dragRef.current.lambda + dx * 0.35,
        Math.max(-80, Math.min(80, dragRef.current.phi - dy * 0.35))
      ]
    }
    const node = getNodeAt(e.clientX, e.clientY)
    setHovered(node)
    setTooltip(node ? { x: e.clientX, y: e.clientY } : null)
  }, [getNodeAt])

  const onMouseUp = useCallback(() => { dragRef.current = null }, [])

  const onClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (wasDragging.current) return
    const node = getNodeAt(e.clientX, e.clientY)
    if (node) onSelect(node)
  }, [getNodeAt, onSelect])

  const onDoubleClick = useCallback(() => {
    autoRotRef.current = !autoRotRef.current
  }, [])

  // Scroll wheel zoom
  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.1 : 0.9
    zoomRef.current = Math.max(0.5, Math.min(6, zoomRef.current * factor))
  }, [])

  // Keyboard zoom
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') zoomRef.current = Math.min(6, zoomRef.current * 1.15)
      if (e.key === '-')                   zoomRef.current = Math.max(0.5, zoomRef.current * 0.87)
      if (e.key === '0')                   { zoomRef.current = 1; autoRotRef.current = true }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div ref={containerRef} className="globe-container">
      <canvas
        ref={canvasRef}
        width={size.w}
        height={size.h}
        className="globe-canvas"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        style={{ cursor: hovered ? 'pointer' : dragRef.current ? 'grabbing' : 'grab' }}
      />

      {/* Legend */}
      <div className="globe-legend">
        <div className="globe-legend-item"><span style={{ background: '#a855f7' }} />{t('filters.wireguard')}</div>
        <div className="globe-legend-item"><span style={{ background: '#34d399' }} />{t('filters.v2ray')}</div>
        <div className="globe-legend-item"><span style={{ background: '#facc15' }} />{t('common.bookmarks')}</div>
        <div className="globe-legend-item"><span style={{ background: '#ef4444' }} />{t('table.inactive_status')}</div>
      </div>

      {/* Controls hint */}
      <div className="globe-hint">
        {t('globe.hint')}
      </div>

      {/* Zoom controls */}
      <div className="globe-zoom-btns">
        <button className="globe-zoom-btn" onClick={() => { zoomRef.current = Math.min(6, zoomRef.current * 1.25) }}>+</button>
        <button className="globe-zoom-btn" onClick={() => { zoomRef.current = 1; autoRotRef.current = true }}>⊙</button>
        <button className="globe-zoom-btn" onClick={() => { zoomRef.current = Math.max(0.5, zoomRef.current * 0.8) }}>−</button>
      </div>

      {/* Tooltip */}
      {hovered && tooltip && (
        <div className="globe-tooltip" style={{ left: tooltip.x + 14, top: tooltip.y - 10 }}>
          <div className="gt-name">{countryToFlag(hovered.country ?? '')} {hovered.moniker}</div>
          <div className="gt-row"><span>{t('table.type')}</span><span>{vpnTypeLabel(hovered.type)}</span></div>
          <div className="gt-row"><span>{t('ip.location')}</span><span>{hovered.city}, {hovered.country}</span></div>
          <div className="gt-row"><span>{t('table.peers')}</span><span style={{ color: 'var(--cyan)' }}>{hovered.peers}</span></div>
          <div className="gt-row"><span>{t('table.sessions')}</span><span>{hovered.sessions}</span></div>
          <div className="gt-connect">{t('globe.tooltip.click_details')}</div>
        </div>
      )}
    </div>
  )
}

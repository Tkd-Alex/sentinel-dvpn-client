import React, { useState, useEffect, useRef } from 'react'
import { TrafficStats } from '../types'

function fmt(bytes: number): string {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB'
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB'
  if (bytes > 1e3) return (bytes / 1e3).toFixed(0) + ' KB'
  return bytes + ' B'
}

function fmtRate(bps: number): string {
  if (bps > 1e6) return (bps / 1e6).toFixed(2) + ' Mb/s'
  if (bps > 1e3) return (bps / 1e3).toFixed(1) + ' Kb/s'
  return Math.round(bps) + ' B/s'
}

export default function TrafficStatsWidget() {
  const [stats,  setStats]  = useState<TrafficStats>({ rx: 0, tx: 0, source: 'none' })
  const [rxRate, setRxRate] = useState(0)
  const [txRate, setTxRate] = useState(0)
  const prevRef = useRef<TrafficStats | null>(null)
  const prevTs  = useRef<number>(Date.now())

  useEffect(() => {
    const unsub = window.api.onTrafficUpdate((data: unknown) => {
      const d = data as TrafficStats
      const now = Date.now()
      const dt  = (now - prevTs.current) / 1000
      prevTs.current = now
      if (prevRef.current && dt > 0) {
        setRxRate(Math.max(0, (d.rx - prevRef.current.rx) / dt))
        setTxRate(Math.max(0, (d.tx - prevRef.current.tx) / dt))
      }
      prevRef.current = d
      setStats(d)
    })
    return () => { unsub() }
  }, [])

  if (stats.source === 'none') return null

  return (
    <div className="traffic-stats" style={{ justifyContent: 'space-between' }}>
      <div className="traffic-col" style={{ flex: 1 }}>
        <span className="traffic-arrow down">↓</span>
        <span className="traffic-value" style={{ minWidth: 55 }}>{fmt(stats.rx)}</span>
        <span className="traffic-rate" style={{ minWidth: 65, textAlign: 'right' }}>{fmtRate(rxRate)}</span>
      </div>
      <div className="traffic-divider" style={{ margin: '0 10px' }} />
      <div className="traffic-col" style={{ flex: 1 }}>
        <span className="traffic-arrow up">↑</span>
        <span className="traffic-value" style={{ minWidth: 55 }}>{fmt(stats.tx)}</span>
        <span className="traffic-rate" style={{ minWidth: 65, textAlign: 'right' }}>{fmtRate(txRate)}</span>
      </div>
    </div>
  )
}

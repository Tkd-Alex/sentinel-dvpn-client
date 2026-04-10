/**
 * Convert a country name to an emoji flag.
 * Falls back to a globe emoji if not found.
 */
export function countryToFlag(country: string): string {
  const map: Record<string, string> = {
    'United States': '🇺🇸', 'United Kingdom': '🇬🇧', 'Germany': '🇩🇪', 'France': '🇫🇷',
    'Netherlands': '🇳🇱', 'Sweden': '🇸🇪', 'Norway': '🇳🇴', 'Finland': '🇫🇮',
    'Switzerland': '🇨🇭', 'Austria': '🇦🇹', 'Belgium': '🇧🇪', 'Spain': '🇪🇸',
    'Italy': '🇮🇹', 'Portugal': '🇵🇹', 'Poland': '🇵🇱', 'Czech Republic': '🇨🇿',
    'Romania': '🇷🇴', 'Hungary': '🇭🇺', 'Bulgaria': '🇧🇬', 'Ukraine': '🇺🇦',
    'Russia': '🇷🇺', 'Turkey': '🇹🇷', 'Canada': '🇨🇦', 'Mexico': '🇲🇽',
    'Brazil': '🇧🇷', 'Argentina': '🇦🇷', 'Chile': '🇨🇱', 'Colombia': '🇨🇴',
    'Japan': '🇯🇵', 'South Korea': '🇰🇷', 'China': '🇨🇳', 'India': '🇮🇳',
    'Singapore': '🇸🇬', 'Hong Kong': '🇭🇰', 'Taiwan': '🇹🇼', 'Thailand': '🇹🇭',
    'Vietnam': '🇻🇳', 'Indonesia': '🇮🇩', 'Malaysia': '🇲🇾', 'Philippines': '🇵🇭',
    'Australia': '🇦🇺', 'New Zealand': '🇳🇿', 'South Africa': '🇿🇦',
    'Israel': '🇮🇱', 'United Arab Emirates': '🇦🇪', 'Saudi Arabia': '🇸🇦',
    'Egypt': '🇪🇬', 'Nigeria': '🇳🇬', 'Kenya': '🇰🇪', 'Morocco': '🇲🇦',
    'Denmark': '🇩🇰', 'Croatia': '🇭🇷', 'Serbia': '🇷🇸', 'Slovakia': '🇸🇰',
    'Lithuania': '🇱🇹', 'Latvia': '🇱🇻', 'Estonia': '🇪🇪', 'Moldova': '🇲🇩',
    'Kazakhstan': '🇰🇿', 'Georgia': '🇬🇪', 'Armenia': '🇦🇲', 'Azerbaijan': '🇦🇿',
    'Belarus': '🇧🇾', 'Greece': '🇬🇷', 'Iceland': '🇮🇸', 'Ireland': '🇮🇪',
    'Luxembourg': '🇱🇺', 'Malta': '🇲🇹', 'Cyprus': '🇨🇾', 'Slovenia': '🇸🇮',
    'Ecuador': '🇪🇨', 'Peru': '🇵🇪', 'Venezuela': '🇻🇪', 'Paraguay': '🇵🇾',
    'Uruguay': '🇺🇾', 'Bolivia': '🇧🇴', 'Cuba': '🇨🇺', 'Dominican Republic': '🇩🇴',
    'Costa Rica': '🇨🇷', 'Guatemala': '🇬🇹', 'Panama': '🇵🇦', 'Puerto Rico': '🇵🇷',
    'Pakistan': '🇵🇰', 'Bangladesh': '🇧🇩', 'Sri Lanka': '🇱🇰', 'Nepal': '🇳🇵',
    'Myanmar': '🇲🇲', 'Cambodia': '🇰🇭', 'Laos': '🇱🇦', 'Mongolia': '🇲🇳',
    'Iran': '🇮🇷', 'Iraq': '🇮🇶', 'Jordan': '🇯🇴', 'Lebanon': '🇱🇧',
    'Kuwait': '🇰🇼', 'Qatar': '🇶🇦', 'Bahrain': '🇧🇭', 'Oman': '🇴🇲',
    'Algeria': '🇩🇿', 'Tunisia': '🇹🇳', 'Libya': '🇱🇾', 'Sudan': '🇸🇩',
    'Ethiopia': '🇪🇹', 'Ghana': '🇬🇭', 'Tanzania': '🇹🇿', 'Uganda': '🇺🇬',
    'Zimbabwe': '🇿🇼', 'Cameroon': '🇨🇲', 'Senegal': '🇸🇳', 'Ivory Coast': '🇨🇮',
  }
  return map[country] ?? '🌐'
}

export function vpnTypeLabel(type: number): string {
  return type === 1 ? 'WireGuard' : type === 2 ? 'V2Ray' : `Type ${type}`
}

export function formatBalance(amount: string, denom: string): string {
  if (denom === 'udvpn') {
    const dvpn = (parseInt(amount, 10) / 1_000_000).toFixed(6)
    return `${dvpn} DVPN`
  }
  if (denom.startsWith('ibc/')) {
    const shortDenom = denom.slice(4, 10) + '…'
    return `${(parseInt(amount, 10) / 1_000_000).toFixed(2)} IBC/${shortDenom}`
  }
  return `${amount} ${denom}`
}

export function formatUdvpnPrice(prices: Array<{ denom: string; value: string }>): string {
  const p = prices.find(x => x.denom === 'udvpn')
  if (!p) return '—'
  const dvpn = (parseInt(p.value, 10) / 1_000_000).toFixed(2)
  return `${dvpn} DVPN`
}

export function truncateAddress(addr: string, len = 12): string {
  if (addr.length <= len * 2 + 3) return addr
  return `${addr.slice(0, len)}…${addr.slice(-6)}`
}

export function uniqueSorted(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))].sort()
}

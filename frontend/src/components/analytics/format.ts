export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

export function formatCost(value: number): string {
  if (value === 0) return '$0.00'
  if (value < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export function formatDuration(seconds: number): string {
  if (!seconds) return '0s'
  if (seconds < 60) return `${Math.round(seconds)}s`
  return `${(seconds / 60).toFixed(1)}min`
}

export function formatTokens(value: number): string {
  return Math.round(value).toLocaleString()
}

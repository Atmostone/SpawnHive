import { useState } from 'react'
import { ArrowDown, ArrowUp, Equal } from 'lucide-react'
import type { TemplateAnalytics } from '@/api/client'
import { formatCost, formatDuration, formatPercent, formatTokens } from './format'

type MetricDirection = 'higher_better' | 'lower_better'

interface MetricDef {
  key: keyof TemplateAnalytics
  label: string
  direction: MetricDirection
  format: (v: number) => string
}

const METRICS: MetricDef[] = [
  { key: 'approval_rate', label: 'Approval rate', direction: 'higher_better', format: formatPercent },
  { key: 'retry_rate', label: 'Retry rate', direction: 'lower_better', format: formatPercent },
  { key: 'failure_rate', label: 'Failure rate', direction: 'lower_better', format: formatPercent },
  { key: 'avg_time_seconds', label: 'Avg time', direction: 'lower_better', format: formatDuration },
  { key: 'avg_input_tokens', label: 'Avg input tokens', direction: 'lower_better', format: formatTokens },
  { key: 'avg_output_tokens', label: 'Avg output tokens', direction: 'lower_better', format: formatTokens },
  { key: 'cost_per_task_usd', label: 'Cost / task', direction: 'lower_better', format: formatCost },
]

const NEAR_TIE_EPSILON = 0.01

function compare(a: number, b: number, direction: MetricDirection): 'a' | 'b' | 'tie' {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9)
  if (Math.abs(a - b) / denom < NEAR_TIE_EPSILON) return 'tie'
  if (direction === 'higher_better') return a > b ? 'a' : 'b'
  return a < b ? 'a' : 'b'
}

function Indicator({ kind }: { kind: 'winner' | 'loser' | 'tie' }) {
  if (kind === 'tie') return <Equal className="h-4 w-4 text-gray-400" aria-label="approximately equal" />
  if (kind === 'winner') return <ArrowUp className="h-4 w-4 text-green-600" aria-label="better" />
  return <ArrowDown className="h-4 w-4 text-red-500" aria-label="worse" />
}

export default function TemplateCompareView({ data }: { data: TemplateAnalytics[] }) {
  const [aId, setAId] = useState<string>('')
  const [bId, setBId] = useState<string>('')

  const a = data.find((t) => t.template_id === aId)
  const b = data.find((t) => t.template_id === bId)

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border p-4">
        <p className="text-sm text-gray-600 mb-3">
          Pick two templates to compare aggregate metrics side by side. Arrows mark the winner per
          metric direction.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Template A</label>
            <select
              className="w-full border rounded-lg px-3 py-2 text-sm"
              value={aId}
              onChange={(e) => setAId(e.target.value)}
            >
              <option value="">Select template…</option>
              {data.map((t) => (
                <option key={t.template_id} value={t.template_id}>
                  {t.template_name} ({t.task_count} tasks)
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Template B</label>
            <select
              className="w-full border rounded-lg px-3 py-2 text-sm"
              value={bId}
              onChange={(e) => setBId(e.target.value)}
            >
              <option value="">Select template…</option>
              {data.map((t) => (
                <option key={t.template_id} value={t.template_id}>
                  {t.template_name} ({t.task_count} tasks)
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {a && b ? (
        <div className="bg-white rounded-lg border overflow-hidden">
          <div className="grid grid-cols-3 bg-gray-50 border-b text-sm font-medium text-gray-700">
            <div className="px-4 py-3">Metric</div>
            <div className="px-4 py-3 text-center">{a.template_name}</div>
            <div className="px-4 py-3 text-center">{b.template_name}</div>
          </div>
          <div className="grid grid-cols-3 border-b text-sm">
            <div className="px-4 py-2 text-gray-600">Tasks observed</div>
            <div className="px-4 py-2 text-center tabular-nums">{a.task_count}</div>
            <div className="px-4 py-2 text-center tabular-nums">{b.task_count}</div>
          </div>
          {METRICS.map((m) => {
            const va = Number(a[m.key]) || 0
            const vb = Number(b[m.key]) || 0
            const result = compare(va, vb, m.direction)
            return (
              <div key={m.key as string} className="grid grid-cols-3 border-b last:border-0 text-sm">
                <div className="px-4 py-2 text-gray-600">
                  {m.label}
                  <span className="ml-2 text-xs text-gray-400">
                    ({m.direction === 'higher_better' ? 'higher better' : 'lower better'})
                  </span>
                </div>
                <div className="px-4 py-2 flex items-center justify-center gap-2 tabular-nums">
                  <Indicator kind={result === 'tie' ? 'tie' : result === 'a' ? 'winner' : 'loser'} />
                  <span>{m.format(va)}</span>
                </div>
                <div className="px-4 py-2 flex items-center justify-center gap-2 tabular-nums">
                  <Indicator kind={result === 'tie' ? 'tie' : result === 'b' ? 'winner' : 'loser'} />
                  <span>{m.format(vb)}</span>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="bg-white rounded-lg border p-8 text-center text-gray-500">
          {data.length < 2
            ? 'Need at least two templates with data to compare'
            : 'Select Template A and Template B to compare'}
        </div>
      )}
    </div>
  )
}

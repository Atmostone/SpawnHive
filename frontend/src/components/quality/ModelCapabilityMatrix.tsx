import { useQuery } from '@tanstack/react-query'
import { qualityApi } from '@/api/client'

// E-13/E-14/E-15 cross-model aggregates surfaced as the "compare models across a
// capability matrix" view — backend endpoints existed (capability/aggregate,
// failure-modes/aggregate, hallucinations/aggregate) with no eyeball surface.
const FAILURE_CLASSES = [
  'tool_confusion',
  'parameter_blind',
  'loop',
  'premature_stop',
  'hallucinated_tool_result',
  'ignored_error',
] as const
const HALLUC_CATS = ['urls', 'apis', 'numbers', 'citations'] as const

function pct(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(n * 100)}%`
}
function scoreColor(s: number | null | undefined): string {
  if (s == null) return 'text-gray-300'
  if (s >= 0.7) return 'text-green-700'
  if (s >= 0.4) return 'text-amber-600'
  return 'text-red-600'
}
// higher rate = worse (failures / hallucinations)
function rateColor(r: number | null | undefined): string {
  if (r == null) return 'text-gray-300'
  if (r >= 0.5) return 'text-red-600'
  if (r >= 0.2) return 'text-amber-600'
  return 'text-gray-600'
}

const th = 'text-right px-3 py-1.5 whitespace-nowrap'
const Empty = () => (
  <div className="px-4 py-6 text-center text-xs text-gray-400">Нет оценённых профилей для этой оси</div>
)

export default function ModelCapabilityMatrix() {
  const capQ = useQuery({ queryKey: ['cap-aggregate'], queryFn: () => qualityApi.getCapabilityAggregate() })
  const failQ = useQuery({ queryKey: ['fail-aggregate'], queryFn: () => qualityApi.getFailureModesAggregate() })
  const hallQ = useQuery({ queryKey: ['halluc-aggregate'], queryFn: () => qualityApi.getHallucinationsAggregate() })

  const isLoading = capQ.isLoading || failQ.isLoading || hallQ.isLoading
  const cap = capQ.data
  const fail = failQ.data
  const hall = hallQ.data
  const capModels = cap ? Object.entries(cap.by_model) : []
  const failModels = fail ? Object.entries(fail.by_model) : []
  const hallModels = hall ? Object.entries(hall.by_model) : []
  const allEmpty = !isLoading && capModels.length === 0 && failModels.length === 0 && hallModels.length === 0

  if (isLoading) {
    return <div className="bg-white rounded-lg border p-8 text-center text-gray-500">Loading capability matrix…</div>
  }
  if (allEmpty) {
    return (
      <div className="bg-white rounded-lg border p-12 text-center text-gray-500">
        <p className="text-base">Пока нет оценённых профилей capability / failure / hallucination</p>
        <p className="text-xs mt-1 text-gray-400">
          Эти кросс-модельные агрегаты (E-13 / E-14 / E-15) заполняются по мере прогона задач с соответствующей оценкой.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-500">
        Сравнение моделей по матрице способностей: чистота решения (E-13), распределение режимов отказа (E-14)
        и доля галлюцинаций (E-15) — по каждой модели воркспейса.
      </p>

      <section className="bg-white rounded-lg border overflow-hidden">
        <header className="px-4 py-2 border-b bg-gray-50 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-gray-800">
            Capability score by model <span className="text-gray-400 font-normal">(E-13 — genuine / total)</span>
          </h3>
          <span className="text-xs text-gray-500">{cap?.total ?? 0} scored runs</span>
        </header>
        {capModels.length === 0 ? (
          <Empty />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 uppercase bg-gray-50/50">
                <tr>
                  <th className="text-left px-4 py-1.5">Model</th>
                  <th className={th}>Score</th>
                  <th className={th}>Genuine</th>
                  <th className={th}>Cheated</th>
                  <th className={th}>Failed w/tool</th>
                  <th className={th}>Failed no-tool</th>
                  <th className={th}>Total</th>
                </tr>
              </thead>
              <tbody>
                {capModels.map(([m, c]) => (
                  <tr key={m} className="border-t">
                    <td className="px-4 py-1.5 font-medium text-gray-800">{m}</td>
                    <td className={`px-3 py-1.5 text-right font-semibold ${scoreColor(c.capability_score)}`}>
                      {c.capability_score == null ? '—' : c.capability_score.toFixed(2)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-gray-600">{c.genuine}</td>
                    <td className="px-3 py-1.5 text-right text-gray-600">{c.cheated}</td>
                    <td className="px-3 py-1.5 text-right text-gray-600">{c.failed_with_tool}</td>
                    <td className="px-3 py-1.5 text-right text-gray-600">{c.failed_no_tool}</td>
                    <td className="px-3 py-1.5 text-right text-gray-500">{c.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bg-white rounded-lg border overflow-hidden">
        <header className="px-4 py-2 border-b bg-gray-50 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-gray-800">
            Failure modes by model <span className="text-gray-400 font-normal">(E-14 — per-class rate)</span>
          </h3>
          <span className="text-xs text-gray-500">{fail?.runs_total ?? 0} runs</span>
        </header>
        {failModels.length === 0 ? (
          <Empty />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 uppercase bg-gray-50/50">
                <tr>
                  <th className="text-left px-4 py-1.5">Model</th>
                  <th className={th}>Any</th>
                  {FAILURE_CLASSES.map((k) => (
                    <th key={k} className={th}>{k.replace(/_/g, ' ')}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {failModels.map(([m, b]) => (
                  <tr key={m} className="border-t">
                    <td className="px-4 py-1.5 font-medium text-gray-800">{m}</td>
                    <td className={`px-3 py-1.5 text-right font-semibold ${rateColor(b.failure_rate)}`}>{pct(b.failure_rate)}</td>
                    {FAILURE_CLASSES.map((k) => (
                      <td key={k} className={`px-3 py-1.5 text-right ${rateColor(b.rate?.[k])}`}>{pct(b.rate?.[k])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bg-white rounded-lg border overflow-hidden">
        <header className="px-4 py-2 border-b bg-gray-50 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-gray-800">
            Hallucination by model <span className="text-gray-400 font-normal">(E-15 — fact-check rate)</span>
          </h3>
          <span className="text-xs text-gray-500">{hall?.runs_total ?? 0} runs</span>
        </header>
        {hallModels.length === 0 ? (
          <Empty />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 uppercase bg-gray-50/50">
                <tr>
                  <th className="text-left px-4 py-1.5">Model</th>
                  <th className={th}>Run rate</th>
                  {HALLUC_CATS.map((c) => (
                    <th key={c} className={th}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {hallModels.map(([m, b]) => (
                  <tr key={m} className="border-t">
                    <td className="px-4 py-1.5 font-medium text-gray-800">{m}</td>
                    <td className={`px-3 py-1.5 text-right font-semibold ${rateColor(b.hallucinated_run_rate)}`}>
                      {pct(b.hallucinated_run_rate)}
                    </td>
                    {HALLUC_CATS.map((c) => (
                      <td
                        key={c}
                        className={`px-3 py-1.5 text-right ${rateColor(b.by_category?.[c]?.rate)}`}
                        title={b.by_category?.[c] ? `${b.by_category[c].hallucinated}/${b.by_category[c].checked} checked` : ''}
                      >
                        {pct(b.by_category?.[c]?.rate)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts'
import { experimentsApi, qualityApi } from '@/api/client'
import RunAnalysis from '@/components/quality/RunAnalysis'
import type { ExperimentDetail as ExperimentDetailType, ExperimentReport } from '@/types'
import { StatusPill } from './Experiments'
import { ArrowLeft, Copy, Download, Pause, Play, RefreshCw, RotateCcw, Square, Trash2, X } from 'lucide-react'

const CONFIG_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777']

function heatStyle(mean: number | null | undefined): React.CSSProperties {
  if (mean == null) return { backgroundColor: '#f3f4f6', color: '#9ca3af' }
  const hue = Math.max(0, Math.min(120, mean * 12)) // 0 → red, 10 → green
  return { backgroundColor: `hsl(${hue}, 75%, 88%)`, color: `hsl(${hue}, 80%, 22%)` }
}

function fmt(v: number | null | undefined, digits = 2): string {
  return v == null ? '—' : v.toFixed(digits)
}

type HeatMode = 'quality' | 'trajectory' | 'off'

// Subtle red→green cell tint (0 → red, 10 → green) so it never overpowers the
// status glyphs printed on top of it.
function cellHeat(mean: number | null | undefined): React.CSSProperties {
  if (mean == null) return {}
  const hue = Math.max(0, Math.min(120, mean * 12))
  return { backgroundColor: `hsl(${hue}, 70%, 92%)` }
}

function CloneModal({ detail, pending, onClose, onClone }: {
  detail: ExperimentDetailType
  pending: boolean
  onClose: () => void
  onClone: (opts: { name?: string; changes?: Record<string, unknown> }) => void
}) {
  const [name, setName] = useState(`${detail.name} (copy)`)
  const [nRuns, setNRuns] = useState(String(detail.n_runs_per_cell))
  const [budget, setBudget] = useState(detail.budget_limit_usd != null ? String(detail.budget_limit_usd) : '')
  const submit = () => {
    const changes: Record<string, unknown> = {}
    if (Number(nRuns) !== detail.n_runs_per_cell) changes.n_runs_per_cell = Number(nRuns)
    const b = budget === '' ? null : Number(budget)
    if (b !== (detail.budget_limit_usd ?? null)) changes.budget_limit_usd = b
    onClone({ name: name.trim() || undefined, changes })
  }
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-md p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Clone experiment</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          New draft with the same frozen dataset &amp; configuration matrix. Tweak name / runs / budget; everything else is copied.
        </p>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Runs per cell (N)</label>
              <input type="number" min={1} max={20} value={nRuns} onChange={(e) => setNRuns(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Budget (USD)</label>
              <input type="number" step="0.01" min={0} value={budget} placeholder="no limit" onChange={(e) => setBudget(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
          </div>
          <button onClick={submit} disabled={pending}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">
            {pending ? 'Cloning…' : 'Create clone (draft)'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ProgressTab({ detail, onCell }: { detail: ExperimentDetailType; onCell: (config: string, caseKey: string) => void }) {
  const [heat, setHeat] = useState<HeatMode>('quality')
  const cases = detail.dataset_cases
  const cells = new Map(detail.matrix.map((c) => [`${c.config_key}|${c.case_key}`, c]))
  if (detail.matrix.length === 0) {
    return <div className="text-sm text-gray-500 p-4">No runs yet — the matrix materializes when the experiment starts.</div>
  }
  return (
    <div className="overflow-x-auto">
      <div className="flex items-center gap-2 mb-3 text-xs">
        <span className="text-gray-500">Heat:</span>
        <div className="flex border rounded-lg overflow-hidden">
          {(['quality', 'trajectory', 'off'] as HeatMode[]).map((m) => (
            <button key={m} onClick={() => setHeat(m)}
              className={`px-2.5 py-1 ${heat === m ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {m === 'off' ? 'off' : m === 'quality' ? 'quality (E-02)' : 'trajectory (E-07)'}
            </button>
          ))}
        </div>
      </div>
      <table className="text-sm border-separate" style={{ borderSpacing: 4 }}>
        <thead>
          <tr>
            <th className="text-left text-xs text-gray-500 px-2">config \ case</th>
            {cases.map((c) => (
              <th key={c.case_key} className="text-xs text-gray-500 font-normal px-2 max-w-32 truncate" title={c.title}>
                {c.case_key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {detail.configurations.map((cfg) => (
            <tr key={cfg.config_key}>
              <td className="text-xs text-gray-700 font-medium px-2 whitespace-nowrap" title={cfg.label}>
                {cfg.config_key} <span className="text-gray-400">{cfg.label}</span>
              </td>
              {cases.map((c) => {
                const cell = cells.get(`${cfg.config_key}|${c.case_key}`)
                const counts = cell?.counts || {}
                const heatVal = heat === 'quality' ? cell?.quality_mean : heat === 'trajectory' ? cell?.trajectory_mean : null
                return (
                  <td key={c.case_key} onClick={() => onCell(cfg.config_key, c.case_key)}
                    style={heat === 'off' ? undefined : cellHeat(heatVal)}
                    className="border rounded-lg px-2 py-1.5 hover:brightness-95 cursor-pointer text-center">
                    <div className="flex items-center justify-center gap-1 text-xs">
                      {counts.success ? <span className="text-green-600 font-medium">{counts.success}✓</span> : null}
                      {counts.failed ? <span className="text-red-600 font-medium">{counts.failed}✗</span> : null}
                      {counts.preprocessing ? <span className="text-purple-600 font-medium" title="preprocessing (Toolathlon seed)">{counts.preprocessing}⚙</span> : null}
                      {counts.running ? <span className="text-blue-600 font-medium">{counts.running}…</span> : null}
                      {counts.evaluating ? <span className="text-indigo-600 font-medium" title="evaluating (executable checker)">{counts.evaluating}⚖</span> : null}
                      {counts.pending ? <span className="text-gray-400">{counts.pending}·</span> : null}
                      {counts.skipped ? <span className="text-amber-600">{counts.skipped}s</span> : null}
                      {Object.keys(counts).length === 0 && <span className="text-gray-300">—</span>}
                    </div>
                    {(cell?.quality_mean != null || cell?.trajectory_mean != null) && (
                      <div className="text-[10px] mt-0.5 text-gray-500 tabular-nums">
                        {cell?.quality_mean != null && <span title="quality mean (E-02)">q{cell.quality_mean}</span>}
                        {cell?.trajectory_mean != null && <span className="ml-1" title="trajectory mean (E-07)">t{cell.trajectory_mean}</span>}
                      </div>
                    )}
                    {cell?.external_total ? (
                      <div className="text-[10px] mt-0.5 tabular-nums" title="executable verdict — passed / evaluated (Toolathlon)">
                        <span className={cell.external_pass === cell.external_total ? 'text-green-600' : cell.external_pass ? 'text-amber-600' : 'text-red-600'}>
                          ✔{cell.external_pass}/{cell.external_total}
                        </span>
                      </div>
                    ) : null}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-xs text-gray-400 mt-2">✓ success · ✗ failed · ⚙ preprocessing · … running · ⚖ evaluating · · pending · s skipped · q=quality · t=trajectory · ✔pass/total=executable verdict — click a cell for run details</div>
    </div>
  )
}

// E-17 judge-trust badge: connects the calibration pillar (judge↔human agreement)
// to the experiment's A/B conclusions. Workspace-global, surfaced here on the report.
function JudgeTrustBadge() {
  const { data: badge } = useQuery({
    queryKey: ['judge-calibration-badge'],
    queryFn: () => qualityApi.getJudgeCalibrationBadge(),
  })
  if (!badge) return null
  if (!badge.calibrated) {
    return (
      <Link to="/calibration" title="Judge not yet calibrated against human annotation (E-17)"
        className="text-xs px-2 py-1 rounded border border-dashed border-gray-300 text-gray-400 hover:text-gray-600">
        judge: not calibrated
      </Link>
    )
  }
  const k = badge.overall_kappa
  const tone = badge.passed ? 'border-green-300 bg-green-50 text-green-700' : 'border-amber-300 bg-amber-50 text-amber-700'
  return (
    <Link to="/calibration" className={`text-xs px-2 py-1 rounded border ${tone}`}
      title={`Judge↔human agreement (E-17): Cohen's κ over ${badge.sample_size ?? '—'} ratings from ${badge.n_humans ?? '—'} annotator(s)`}>
      judge κ {k == null ? '—' : k.toFixed(2)}{badge.passed ? ' ✓' : ' ⚠'}
    </Link>
  )
}

function ReportTab({ id, isTerminal }: { id: string; isTerminal: boolean }) {
  const queryClient = useQueryClient()
  const [method, setMethod] = useState<'bt' | 'elo'>('bt')
  const [refreshing, setRefreshing] = useState(false)
  const { data: report, isLoading } = useQuery({
    queryKey: ['experiment-report', id, method],
    queryFn: () => experimentsApi.report(id, { method }),
    refetchInterval: isTerminal ? false : 10000,
  })
  const onRefresh = async () => {
    setRefreshing(true)
    try {
      const fresh = await experimentsApi.report(id, { method, refresh: true })
      queryClient.setQueryData(['experiment-report', id, method], fresh)
    } finally {
      setRefreshing(false)
    }
  }
  if (isLoading || !report) return <div className="text-sm text-gray-500 p-4">Assembling report…</div>
  return <ReportView report={report} method={method} setMethod={setMethod} onRefresh={onRefresh} refreshing={refreshing} />
}

function ReportView({ report, method, setMethod, onRefresh, refreshing }: {
  report: ExperimentReport
  method: 'bt' | 'elo'
  setMethod: (m: 'bt' | 'elo') => void
  onRefresh: () => void
  refreshing: boolean
}) {
  const colorByConfig = new Map(
    report.summary.per_config.map((c, i) => [c.config_key, CONFIG_COLORS[i % CONFIG_COLORS.length]]),
  )
  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `experiment-report-${report.generated_at}.json`
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs text-gray-400 mr-auto">assembled {new Date(report.generated_at).toLocaleString()}</span>
        <JudgeTrustBadge />
        <button onClick={onRefresh} disabled={refreshing} title="Re-assemble report (bypass cache)"
          className="flex items-center gap-1.5 px-2.5 py-1.5 border rounded-lg hover:bg-gray-50 text-xs disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> {refreshing ? 'Re-assembling…' : 'Re-assemble'}
        </button>
        <button onClick={downloadJson} title="Download assembled report as JSON"
          className="flex items-center gap-1.5 px-2.5 py-1.5 border rounded-lg hover:bg-gray-50 text-xs">
          <Download className="h-3.5 w-3.5" /> JSON
        </button>
      </div>
      {report.partial && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Partial report — the experiment is still running ({report.n_terminal_runs} runs settled).
        </div>
      )}

      <section>
        <h3 className="font-semibold text-gray-900 mb-2">Summary</h3>
        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
              <tr>
                <th className="px-3 py-2">Configuration</th>
                <th className="px-3 py-2">Runs</th>
                <th className="px-3 py-2">Success</th>
                <th className="px-3 py-2">Quality</th>
                <th className="px-3 py-2">Trajectory</th>
                <th className="px-3 py-2">Cost avg</th>
                <th className="px-3 py-2">Time avg</th>
              </tr>
            </thead>
            <tbody>
              {report.summary.per_config.map((c) => (
                <tr key={c.config_key} className="border-t">
                  <td className="px-3 py-2 font-medium" style={{ color: colorByConfig.get(c.config_key) }}>
                    {c.config_key} <span className="text-gray-500 font-normal">{c.label}</span>
                  </td>
                  <td className="px-3 py-2">{c.n_runs}</td>
                  <td className="px-3 py-2">{c.success_rate != null ? `${(c.success_rate * 100).toFixed(0)}%` : '—'}</td>
                  <td className="px-3 py-2">{fmt(c.quality_mean)}</td>
                  <td className="px-3 py-2">{fmt(c.trajectory_mean)}</td>
                  <td className="px-3 py-2">${fmt(c.cost_mean, 3)}</td>
                  <td className="px-3 py-2">{c.duration_mean != null ? `${Math.round(c.duration_mean)}s` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="font-semibold text-gray-900 mb-2">Quality profile heatmap</h3>
        {report.heatmap.dimensions.length === 0 ? (
          <p className="text-sm text-gray-500">No rubric dimension scores yet (configure a judge model to score runs).</p>
        ) : (
          <div className="bg-white border rounded-lg overflow-x-auto p-3">
            <table className="text-sm border-separate" style={{ borderSpacing: 3 }}>
              <thead>
                <tr>
                  <th className="text-left text-xs text-gray-500 px-2">config</th>
                  {report.heatmap.dimensions.map((d) => (
                    <th key={d} className="text-xs text-gray-500 font-normal px-2">{d}</th>
                  ))}
                  <th className="text-xs text-gray-700 font-medium px-2">weighted</th>
                </tr>
              </thead>
              <tbody>
                {report.heatmap.rows.map((row) => (
                  <tr key={row.config_key}>
                    <td className="text-xs font-medium px-2 whitespace-nowrap" title={row.label}>{row.config_key}</td>
                    {report.heatmap.dimensions.map((d) => {
                      const cell = row.cells[d]
                      return (
                        <td key={d} className="rounded px-3 py-2 text-center text-sm font-medium" style={heatStyle(cell?.mean)}
                          title={cell ? `n=${cell.n}${cell.std != null ? ` · std=${cell.std}` : ''}` : ''}>
                          {fmt(cell?.mean, 1)}
                        </td>
                      )
                    })}
                    <td className="rounded px-3 py-2 text-center text-sm font-bold" style={heatStyle(row.weighted_score.mean)}>
                      {fmt(row.weighted_score.mean, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="font-semibold text-gray-900 mb-2">
          Trajectory profile heatmap <span className="text-xs text-gray-400 font-normal">6-axis process judge (E-07) per config</span>
        </h3>
        {report.trajectory_heatmap.axes.length === 0 ? (
          <p className="text-sm text-gray-500">No trajectory scores yet (the 6-axis process judge runs on settled runs with a trace).</p>
        ) : (
          <div className="bg-white border rounded-lg overflow-x-auto p-3">
            <table className="text-sm border-separate" style={{ borderSpacing: 3 }}>
              <thead>
                <tr>
                  <th className="text-left text-xs text-gray-500 px-2">config</th>
                  {report.trajectory_heatmap.axes.map((a) => (
                    <th key={a} className="text-xs text-gray-500 font-normal px-2" title={report.trajectory_heatmap.axis_labels[a]}>
                      {(report.trajectory_heatmap.axis_labels[a] || a).replace(/_/g, ' ')}
                    </th>
                  ))}
                  <th className="text-xs text-gray-700 font-medium px-2">overall</th>
                </tr>
              </thead>
              <tbody>
                {report.trajectory_heatmap.rows.map((row) => (
                  <tr key={row.config_key}>
                    <td className="text-xs font-medium px-2 whitespace-nowrap" title={row.label}>{row.config_key}</td>
                    {report.trajectory_heatmap.axes.map((a) => {
                      const cell = row.cells[a]
                      return (
                        <td key={a} className="rounded px-3 py-2 text-center text-sm font-medium" style={heatStyle(cell?.mean)}
                          title={cell ? `n=${cell.n}${cell.std != null ? ` · std=${cell.std}` : ''}` : ''}>
                          {fmt(cell?.mean, 1)}
                        </td>
                      )
                    })}
                    <td className="rounded px-3 py-2 text-center text-sm font-bold" style={heatStyle(row.overall_score.mean)}>
                      {fmt(row.overall_score.mean, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {report.trajectory_match.available && (
        <section>
          <h3 className="font-semibold text-gray-900 mb-2">
            Trajectory match <span className="text-xs text-gray-400 font-normal">vs canonical gold trajectory (E-09)</span>
          </h3>
          <div className="bg-white border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-3 py-2">Configuration</th>
                  <th className="px-3 py-2">Match rate</th>
                  <th className="px-3 py-2">Score mean</th>
                  <th className="px-3 py-2">Scored</th>
                </tr>
              </thead>
              <tbody>
                {report.trajectory_match.per_config.map((c) => (
                  <tr key={c.config_key} className="border-t">
                    <td className="px-3 py-2 font-medium">{c.config_key} <span className="text-gray-500 font-normal">{c.label}</span></td>
                    <td className="px-3 py-2">{c.match_rate != null ? `${(c.match_rate * 100).toFixed(0)}%` : '—'}</td>
                    <td className="px-3 py-2">{fmt(c.score_mean, 2)}</td>
                    <td className="px-3 py-2 text-gray-500">{c.n_scored}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report.external?.available && (
        <section>
          <h3 className="font-semibold text-gray-900 mb-2">
            Executable pass-rate <span className="text-xs text-gray-400 font-normal">Toolathlon external checker (gold.external_eval) — ground-truth outcome</span>
          </h3>
          <div className="bg-white border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-3 py-2">Configuration</th>
                  <th className="px-3 py-2">Pass rate</th>
                  <th className="px-3 py-2">Passed</th>
                  <th className="px-3 py-2">Evaluated</th>
                </tr>
              </thead>
              <tbody>
                {report.external.per_config.map((c) => (
                  <tr key={c.config_key} className="border-t">
                    <td className="px-3 py-2 font-medium">{c.config_key} <span className="text-gray-500 font-normal">{c.label}</span></td>
                    <td className="px-3 py-2 font-semibold">{c.pass_rate != null ? `${(c.pass_rate * 100).toFixed(0)}%` : '—'}</td>
                    <td className="px-3 py-2 text-green-700">{c.n_pass}</td>
                    <td className="px-3 py-2 text-gray-500">{c.n_evaluated}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report.rq2?.available && (
        <section>
          <h3 className="font-semibold text-gray-900 mb-2">
            RQ2 · verdict × judge{' '}
            <span className="text-xs text-gray-400 font-normal">
              executable pass/fail vs outcome judge (≥{report.rq2.judge_threshold}) — agreement{' '}
              {report.rq2.overall.agreement != null ? `${(report.rq2.overall.agreement * 100).toFixed(0)}%` : '—'} (n={report.rq2.overall.n})
            </span>
          </h3>
          <div className="bg-white border rounded-lg p-4 max-w-md">
            <div className="grid grid-cols-[auto_1fr_1fr] gap-1 text-sm text-center">
              <div></div>
              <div className="text-xs text-gray-500 font-medium py-1">judge high</div>
              <div className="text-xs text-gray-500 font-medium py-1">judge low</div>
              <div className="text-xs text-gray-500 font-medium flex items-center justify-end pr-2">checker pass</div>
              <div className="bg-green-50 text-green-700 font-semibold py-3 rounded" title="checker passed & judge high — agree">{report.rq2.overall.cells.pass_high}</div>
              <div className="bg-amber-50 text-amber-700 font-semibold py-3 rounded" title="checker passed but judge scored low — judge under-credits">{report.rq2.overall.cells.pass_low}</div>
              <div className="text-xs text-gray-500 font-medium flex items-center justify-end pr-2">checker fail</div>
              <div className="bg-amber-50 text-amber-700 font-semibold py-3 rounded" title="judge scored high but checker failed — judge over-credits">{report.rq2.overall.cells.fail_high}</div>
              <div className="bg-red-50 text-red-700 font-semibold py-3 rounded" title="checker failed & judge low — agree">{report.rq2.overall.cells.fail_low}</div>
            </div>
            <p className="text-[11px] text-gray-400 mt-2">Diagonal (green/red) = judge agrees with the executable checker; off-diagonal (amber) = disagreement.</p>
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section>
          <h3 className="font-semibold text-gray-900 mb-2">Pareto frontier <span className="text-xs text-gray-400 font-normal">quality × cost (size = time)</span></h3>
          <div className="bg-white border rounded-lg p-3 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" dataKey="cost" name="cost" unit="$" tick={{ fontSize: 11 }} />
                <YAxis type="number" dataKey="quality" name="quality" domain={[0, 10]} tick={{ fontSize: 11 }} />
                <ZAxis type="number" dataKey="time" range={[60, 400]} name="time" unit="s" />
                <Tooltip cursor={{ strokeDasharray: '3 3' }}
                  formatter={(v) => (typeof v === 'number' ? v.toFixed(3) : String(v ?? ''))}
                  labelFormatter={() => ''} />
                <Legend />
                <Scatter name="frontier" data={report.pareto.points.filter((p) => p.on_frontier)} fill="#16a34a" />
                <Scatter name="dominated" data={report.pareto.points.filter((p) => !p.on_frontier)} fill="#9ca3af" />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section>
          <h3 className="font-semibold text-gray-900 mb-2">Outcome × Trajectory <span className="text-xs text-gray-400 font-normal">per run</span></h3>
          <div className="bg-white border rounded-lg p-3 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" dataKey="outcome" name="outcome" domain={[0, 10]} tick={{ fontSize: 11 }} />
                <YAxis type="number" dataKey="trajectory" name="trajectory" domain={[0, 10]} tick={{ fontSize: 11 }} />
                <Tooltip cursor={{ strokeDasharray: '3 3' }} />
                <Legend />
                {report.summary.per_config.map((c) => (
                  <Scatter key={c.config_key} name={c.config_key}
                    data={report.scatter.filter((p) => p.config_key === c.config_key && p.outcome != null && p.trajectory != null)}
                    fill={colorByConfig.get(c.config_key)} />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <section>
        <div className="flex items-center gap-3 mb-2">
          <h3 className="font-semibold text-gray-900">Pairwise leaderboard</h3>
          <div className="flex rounded-lg border overflow-hidden text-xs">
            {(['bt', 'elo'] as const).map((m) => (
              <button key={m} onClick={() => setMethod(m)}
                className={`px-2.5 py-1 ${method === m ? 'bg-blue-600 text-white' : 'bg-white hover:bg-gray-50'}`}>
                {m === 'bt' ? 'Bradley-Terry' : 'Elo'}
              </button>
            ))}
          </div>
          <span className="text-xs text-gray-400">derived from pointwise scores, case-paired</span>
        </div>
        {report.leaderboard.status !== 'ok' ? (
          <p className="text-sm text-gray-500">Not enough scored runs for a leaderboard ({report.leaderboard.status}).</p>
        ) : (
          <div className="bg-white border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Configuration</th>
                  <th className="px-3 py-2">Rating</th>
                  <th className="px-3 py-2">95% CI</th>
                  <th className="px-3 py-2">W / L / T</th>
                </tr>
              </thead>
              <tbody>
                {report.leaderboard.players.map((p) => (
                  <tr key={p.player} className="border-t">
                    <td className="px-3 py-2 font-bold">{p.rank}</td>
                    <td className="px-3 py-2 font-medium">{p.player} <span className="text-gray-500 font-normal">{p.label}</span></td>
                    <td className="px-3 py-2">{p.rating.toFixed(0)}</td>
                    <td className="px-3 py-2 text-gray-500">
                      {p.ci_low != null ? `${p.ci_low.toFixed(0)} – ${p.ci_high?.toFixed(0)}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-gray-600">{p.wins ?? 0} / {p.losses ?? 0} / {p.ties ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="font-semibold text-gray-900 mb-2">Statistical significance <span className="text-xs text-gray-400 font-normal">Welch t-test (primary) + Mann-Whitney U (approx); ★ = p &lt; 0.05</span></h3>
        {report.significance.length === 0 ? (
          <p className="text-sm text-gray-500">Not enough samples per cell yet (need n ≥ 3 scored runs on both sides).</p>
        ) : (
          <div className="bg-white border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-3 py-2">Pair</th>
                  <th className="px-3 py-2">Metric</th>
                  <th className="px-3 py-2">Welch p</th>
                  <th className="px-3 py-2">Mann-Whitney p</th>
                  <th className="px-3 py-2">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {report.significance.map((s) => (
                  <tr key={`${s.a}-${s.b}-${s.metric}`} className="border-t">
                    <td className="px-3 py-2">{s.a} vs {s.b}</td>
                    <td className="px-3 py-2 text-gray-600">{s.metric}</td>
                    <td className="px-3 py-2">{s.welch ? s.welch.p.toFixed(4) : '—'}</td>
                    <td className="px-3 py-2">{s.mann_whitney ? s.mann_whitney.p.toFixed(4) : '—'}</td>
                    <td className="px-3 py-2">
                      {s.significant
                        ? <span className="text-green-700 font-medium">★ significant</span>
                        : <span className="text-gray-400">not significant</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section>
          <h3 className="font-semibold text-gray-900 mb-2">Failure modes</h3>
          <div className="bg-white border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-3 py-2">Configuration</th>
                  <th className="px-3 py-2">Statuses</th>
                  <th className="px-3 py-2">Failure classes</th>
                </tr>
              </thead>
              <tbody>
                {report.failure_modes.per_config.map((f) => (
                  <tr key={f.config_key} className="border-t align-top">
                    <td className="px-3 py-2 font-medium">{f.config_key}</td>
                    <td className="px-3 py-2 text-gray-600">
                      {Object.entries(f.statuses).map(([s, n]) => `${s}: ${n}`).join(' · ') || '—'}
                    </td>
                    <td className="px-3 py-2 text-gray-600">
                      {Object.keys(f.classes).length
                        ? Object.entries(f.classes).map(([c, n]) => `${c}: ${n}`).join(' · ')
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h3 className="font-semibold text-gray-900 mb-2">Orchestrator on / off</h3>
          {!report.orchestrator.on || !report.orchestrator.off ? (
            <p className="text-sm text-gray-500">
              Add configurations on both sides of the <code>orchestrator</code> axis to compare orchestration impact.
            </p>
          ) : (
            <div className="bg-white border rounded-lg p-4">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-gray-500 uppercase">
                  <tr><th /><th className="py-1">orchestrator: on</th><th className="py-1">off</th><th className="py-1">Δ (on − off)</th></tr>
                </thead>
                <tbody>
                  {([
                    ['quality_mean', 'Quality'],
                    ['trajectory_mean', 'Trajectory'],
                    ['success_rate', 'Success rate'],
                    ['cost_mean', 'Cost avg, $'],
                    ['duration_mean', 'Time avg, s'],
                  ] as const).map(([key, label]) => (
                    <tr key={key} className="border-t">
                      <td className="py-1.5 text-gray-600">{label}</td>
                      <td className="py-1.5">{fmt(report.orchestrator.on?.[key])}</td>
                      <td className="py-1.5">{fmt(report.orchestrator.off?.[key])}</td>
                      <td className="py-1.5 font-medium">{fmt(report.orchestrator.delta?.[key])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-gray-400 mt-2">
                on: {report.orchestrator.on.configs.join(', ')} · off: {report.orchestrator.off.configs.join(', ')}
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function RunsTab({ id, detail, filter }: {
  id: string
  detail: ExperimentDetailType
  filter: { config?: string; case?: string }
}) {
  const [config, setConfig] = useState(filter.config || '')
  const [caseKey, setCaseKey] = useState(filter.case || '')
  const [openTask, setOpenTask] = useState<string | null>(null)
  const { data: rows = [] } = useQuery({
    queryKey: ['experiment-results', id, config, caseKey],
    queryFn: () =>
      experimentsApi.results(id, {
        ...(config ? { config } : {}),
        ...(caseKey ? { case: caseKey } : {}),
      }),
  })
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <select value={config} onChange={(e) => setConfig(e.target.value)}
          className="px-2 py-1.5 border rounded text-sm bg-white">
          <option value="">all configurations</option>
          {detail.configurations.map((c) => (
            <option key={c.config_key} value={c.config_key}>{c.config_key} — {c.label}</option>
          ))}
        </select>
        <select value={caseKey} onChange={(e) => setCaseKey(e.target.value)}
          className="px-2 py-1.5 border rounded text-sm bg-white">
          <option value="">all cases</option>
          {detail.dataset_cases.map((c) => (
            <option key={c.case_key} value={c.case_key}>{c.case_key}</option>
          ))}
        </select>
        <span className="text-xs text-gray-400">{rows.length} runs</span>
      </div>
      <div className="bg-white border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
            <tr>
              <th className="px-3 py-2"></th>
              <th className="px-3 py-2">Cell</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Verdict</th>
              <th className="px-3 py-2">Quality</th>
              <th className="px-3 py-2">Trajectory</th>
              <th className="px-3 py-2">Cost</th>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const canInspect = !!r.task_id
              const open = openTask === r.task_id
              return (
                <Fragment key={`${r.config_key}-${r.case_key}-${r.run_index}`}>
                  <tr className="border-t">
                    <td className="px-3 py-2">
                      {canInspect && (
                        <button
                          onClick={() => setOpenTask((t) => (t === r.task_id ? null : r.task_id!))}
                          className={`px-2.5 py-1 text-xs rounded border whitespace-nowrap transition-colors ${
                            open
                              ? 'border-blue-400 bg-blue-50 text-blue-700'
                              : 'border-gray-300 bg-white text-gray-600 hover:bg-blue-50 hover:border-blue-400 hover:text-blue-700'
                          }`}
                        >
                          {open ? 'close' : 'inspect'}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-700">
                      {r.config_key} · {r.case_key} · #{r.run_index + 1}
                    </td>
                    <td className="px-3 py-2">
                      <span className={
                        r.status === 'success' ? 'text-green-600' :
                        r.status === 'failed' ? 'text-red-600' :
                        r.status === 'running' ? 'text-blue-600' : 'text-gray-400'
                      }>{r.status}</span>
                    </td>
                    <td className="px-3 py-2">
                      {r.external_verdict === 'pass' ? (
                        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">pass</span>
                      ) : r.external_verdict === 'fail' ? (
                        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">fail</span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{fmt(r.weighted_score, 1)}</td>
                    <td className="px-3 py-2">{fmt(r.trajectory_score, 1)}</td>
                    <td className="px-3 py-2">${r.cost_usd.toFixed(3)}</td>
                    <td className="px-3 py-2">{r.duration_seconds != null ? `${r.duration_seconds}s` : '—'}</td>
                    <td className="px-3 py-2 text-gray-500 max-w-md truncate" title={r.result_summary || ''}>
                      {r.result_summary || '—'}
                    </td>
                  </tr>
                  {open && r.task_id && (
                    <tr className="border-t bg-gray-50">
                      <td colSpan={9} className="px-3 py-3">
                        <RunAnalysis
                          taskId={r.task_id}
                          profile={r.quality_profile ?? null}
                          onSaved={() => setOpenTask(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function ExperimentDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'progress' | 'report' | 'runs'>('progress')
  const [runsFilter, setRunsFilter] = useState<{ config?: string; case?: string }>({})
  const [showClone, setShowClone] = useState(false)

  const { data: detail } = useQuery({
    queryKey: ['experiment', id],
    queryFn: () => experimentsApi.get(id),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 4000 : false),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['experiment', id] })
    queryClient.invalidateQueries({ queryKey: ['experiments'] })
  }
  const runMutation = useMutation({ mutationFn: () => experimentsApi.run(id), onSuccess: invalidate })
  const pauseMutation = useMutation({ mutationFn: () => experimentsApi.pause(id), onSuccess: invalidate })
  const resumeMutation = useMutation({ mutationFn: () => experimentsApi.resume(id), onSuccess: invalidate })
  const cancelMutation = useMutation({ mutationFn: () => experimentsApi.cancel(id), onSuccess: invalidate })
  const deleteMutation = useMutation({
    mutationFn: () => experimentsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['experiments'] })
      navigate('/experiments')
    },
  })

  const cloneMutation = useMutation({
    mutationFn: async (opts: { alsoRun?: boolean; name?: string; changes?: Record<string, unknown> }) => {
      const payload: { name?: string; changes?: Record<string, unknown> } = {}
      if (opts.name) payload.name = opts.name
      if (opts.changes && Object.keys(opts.changes).length) payload.changes = opts.changes
      const clone = await experimentsApi.clone(id, payload)
      if (opts.alsoRun) await experimentsApi.run(clone.id)
      return clone
    },
    onSuccess: (clone) => {
      setShowClone(false)
      queryClient.invalidateQueries({ queryKey: ['experiments'] })
      navigate(`/experiments/${clone.id}`)
    },
  })

  const download = async (format: 'csv' | 'json') => {
    const blob = await experimentsApi.export(id, format)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `experiment-${id}.${format}`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!detail) return <div className="p-6 text-sm text-gray-500">Loading…</div>

  const isTerminal = ['completed', 'capped', 'failed', 'cancelled'].includes(detail.status)

  return (
    <div className="p-6">
      <button onClick={() => navigate('/experiments')}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3">
        <ArrowLeft className="h-4 w-4" /> Experiments
      </button>

      <div className="flex items-start justify-between mb-1">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
            {detail.name} <StatusPill status={detail.status} />
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {detail.n_configs} configs × {detail.n_cases} cases × {detail.n_runs_per_cell} runs = {detail.total_runs} ·
            spent ${detail.accumulated_cost_usd.toFixed(2)}
            {detail.budget_limit_usd != null && ` / $${detail.budget_limit_usd.toFixed(2)}`}
            {detail.description ? ` · ${detail.description}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {detail.status === 'draft' && (
            <button onClick={() => runMutation.mutate()} disabled={runMutation.isPending}
              className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium">
              <Play className="h-4 w-4" /> Run
            </button>
          )}
          {detail.status === 'running' && (
            <button onClick={() => pauseMutation.mutate()}
              className="flex items-center gap-1.5 px-3 py-2 border rounded-lg hover:bg-gray-50 text-sm">
              <Pause className="h-4 w-4" /> Pause
            </button>
          )}
          {detail.status === 'paused' && (
            <button onClick={() => resumeMutation.mutate()}
              className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium">
              <Play className="h-4 w-4" /> Resume
            </button>
          )}
          {!isTerminal && detail.status !== 'draft' && (
            <button onClick={() => { if (confirm('Cancel this experiment? Partial results are kept.')) cancelMutation.mutate() }}
              className="flex items-center gap-1.5 px-3 py-2 border border-red-200 text-red-600 rounded-lg hover:bg-red-50 text-sm">
              <Square className="h-4 w-4" /> Cancel
            </button>
          )}
          <button onClick={() => setShowClone(true)} title="Clone as a new draft, optionally tweaking name / runs / budget"
            className="flex items-center gap-1.5 px-3 py-2 border rounded-lg hover:bg-gray-50 text-sm">
            <Copy className="h-4 w-4" /> Clone…
          </button>
          {isTerminal && (
            <button onClick={() => cloneMutation.mutate({ alsoRun: true })} title="Full reproduction: clone + run"
              className="flex items-center gap-1.5 px-3 py-2 border rounded-lg hover:bg-gray-50 text-sm">
              <RotateCcw className="h-4 w-4" /> Re-run
            </button>
          )}
          <button onClick={() => download('csv')} title="Export runs as CSV"
            className="flex items-center gap-1.5 px-3 py-2 border rounded-lg hover:bg-gray-50 text-sm">
            <Download className="h-4 w-4" /> CSV
          </button>
          <button onClick={() => download('json')} title="Export runs as JSON"
            className="flex items-center gap-1.5 px-3 py-2 border rounded-lg hover:bg-gray-50 text-sm">
            <Download className="h-4 w-4" /> JSON
          </button>
          {detail.status !== 'running' && (
            <button onClick={() => { if (confirm('Delete this experiment? This cannot be undone.')) deleteMutation.mutate() }}
              title="Delete experiment"
              className="flex items-center gap-1.5 px-3 py-2 border border-red-200 text-red-600 rounded-lg hover:bg-red-50 text-sm">
              <Trash2 className="h-4 w-4" /> Delete
            </button>
          )}
        </div>
      </div>
      {detail.error && <div className="text-xs text-red-600 mb-2">{detail.error}</div>}

      <div className="flex gap-1 border-b mb-4 mt-4">
        {(['progress', 'report', 'runs'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {t === 'progress' ? 'Progress' : t === 'report' ? 'Report' : 'Runs'}
          </button>
        ))}
      </div>

      {tab === 'progress' && (
        <ProgressTab detail={detail} onCell={(config, caseKey) => { setRunsFilter({ config, case: caseKey }); setTab('runs') }} />
      )}
      {tab === 'report' && <ReportTab id={id} isTerminal={isTerminal} />}
      {tab === 'runs' && <RunsTab id={id} detail={detail} filter={runsFilter} />}

      {showClone && (
        <CloneModal detail={detail} pending={cloneMutation.isPending}
          onClose={() => setShowClone(false)} onClone={(o) => cloneMutation.mutate(o)} />
      )}
    </div>
  )
}

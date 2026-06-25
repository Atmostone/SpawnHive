import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  ReferenceLine,
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
import SummaryRadarPanel from '@/components/quality/SummaryRadarPanel'
import type { ExperimentCostRow, ExperimentDetail as ExperimentDetailType, ExperimentReport } from '@/types'
import { StatusPill } from './Experiments'
import { ArrowLeft, Copy, Download, Pause, Play, RefreshCw, RotateCcw, Square, Trash2, X } from 'lucide-react'

const CONFIG_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777']

function heatStyle(mean: number | null | undefined): React.CSSProperties {
  if (mean == null) return { backgroundColor: '#f3f4f6', color: '#9ca3af' }
  const hue = Math.max(0, Math.min(120, mean * 12)) // 0 → red, 10 → green
  // 85% sat / 85% light — same stronger tint as cellHeat so the Report heatmaps
  // stay legible under red-green colour-blindness; the printed number is the cue.
  return { backgroundColor: `hsl(${hue}, 85%, 85%)`, color: `hsl(${hue}, 80%, 22%)` }
}

function fmt(v: number | null | undefined, digits = 2): string {
  return v == null ? '—' : v.toFixed(digits)
}

type HeatMode = 'quality' | 'trajectory' | 'human' | 'off'

// Plain-language names + one-line explanations for the Heat toggle. The internal
// E-codes are kept (the team uses them) but always paired with what they MEAN, so a
// non-author is not left guessing what "q" / "t" measure.
const HEAT_LABEL: Record<HeatMode, string> = {
  quality: 'Outcome quality (E-02)',
  trajectory: 'Process trajectory (E-07)',
  human: 'Human (E-05)',
  off: 'off',
}
const HEAT_HELP: Record<HeatMode, string> = {
  quality:
    'Outcome quality — the LLM judge rubric score of the final RESULT (E-02). Red = weak result, green = strong; higher is better.',
  trajectory:
    'Process trajectory — the 6-axis judge score of HOW the agent worked: efficiency, tool choice, error recovery, goal alignment… (E-07). Higher = cleaner process.',
  human:
    'Human (E-05) — your own dimension ratings and approve/reject verdict on the run; the ground-truth oracle used for judge calibration.',
  off: 'No cell colouring — show only the run-outcome glyphs.',
}

// Significance-table metric keys are programmatic (weighted_score / trajectory_score
// / dim:<x>); map them to human names + which judge produced them, so a reader can
// tell outcome (E-02) rows from process (E-07) rows at a glance.
function metricLabel(metric: string): string {
  if (metric === 'weighted_score') return 'Overall quality'
  if (metric === 'trajectory_score') return 'Overall trajectory'
  if (metric.startsWith('dim:')) return metric.slice(4).replace(/_/g, ' ')
  return metric.replace(/_/g, ' ')
}
function metricJudge(metric: string): { label: string; cls: string } {
  if (metric === 'trajectory_score')
    return { label: 'Trajectory (E-07)', cls: 'text-purple-700 bg-purple-50' }
  // weighted_score + every dim:* are outcome-rubric metrics from the E-02 judge.
  return { label: 'Quality (E-02)', cls: 'text-blue-700 bg-blue-50' }
}

// Per-cell dimension/axis means (sorted worst-first by the backend) → a compact
// "low→high" line for the cell tooltip, so a reader can see which axis drags the
// score down without opening the run. (SPA-73)
function fmtBreakdown(rows?: { name: string; mean: number }[]): string {
  if (!rows || rows.length === 0) return ''
  return rows.map((r) => `${r.name} ${r.mean}`).join(' · ')
}

function fmtUsd(v: number | null | undefined, digits = 3): string {
  return v == null ? '—' : `$${v.toFixed(digits)}`
}

// Subtle red→green cell tint (0 → red, 10 → green) so it never overpowers the
// status glyphs printed on top of it. 85% sat / 85% light keeps the red↔green
// signal distinguishable under deuteranopia; the numeric q/t/human score printed in
// the cell stays the primary cue, colour is only an accent.
function cellHeat(mean: number | null | undefined): React.CSSProperties {
  if (mean == null) return {}
  const hue = Math.max(0, Math.min(120, mean * 12))
  return { backgroundColor: `hsl(${hue}, 85%, 85%)` }
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
  // Verifiable bench: an executable checker provides a ground-truth verdict, but
  // the checker is itself unreliable (~21% vs gold), so the LLM judge (E-02) and
  // human (E-05) are shown ALONGSIDE it as independent oracles — all three are
  // available as heat views and on every cell (triangulation). Default to the
  // trajectory view on verifiable benches where the cell already shows ✔checker.
  const verifiable = detail.matrix.some((c) => (c.external_total ?? 0) > 0)
  const anyHuman = detail.matrix.some((c) => (c.human_rated ?? 0) > 0)
  const [heat, setHeat] = useState<HeatMode>(verifiable ? 'trajectory' : 'quality')
  const cases = detail.dataset_cases
  const cells = new Map(detail.matrix.map((c) => [`${c.config_key}|${c.case_key}`, c]))
  const labelOf = new Map(detail.configurations.map((c) => [c.config_key, c.label || c.config_key]))
  // Triangulation scatter: every cell with BOTH a judge (E-02 quality) and a human
  // (E-05) score — point colored by the executable checker verdict so checker
  // false-negatives (✗ checker, but high judge+human) jump off the y=x line.
  const triPoints = detail.matrix
    .filter((c) => c.quality_mean != null && c.human_mean != null)
    .map((c) => {
      const total = c.external_total ?? 0
      return {
        judge: c.quality_mean as number,
        human: c.human_mean as number,
        label: `${labelOf.get(c.config_key) ?? c.config_key} · ${c.case_key}`,
        checker: total === 0 ? 'none' : (c.external_pass ?? 0) >= total ? 'pass' : 'fail',
      }
    })
  if (detail.matrix.length === 0) {
    return (
      <div className="text-sm text-gray-500 p-4 max-w-2xl space-y-1">
        <p className="font-medium text-gray-700">No runs yet.</p>
        <p>
          The matrix materializes when the experiment starts — one row per dataset case, one column per
          configuration, each cell holding the N runs of that case under that config.
        </p>
        <p className="text-gray-400">
          {detail.status === 'draft'
            ? 'This experiment is a draft — press Run (top right) to launch it.'
            : 'Cells will fill in as runs are scheduled and scored.'}
        </p>
      </div>
    )
  }
  return (
    <div className="overflow-x-auto">
      <div className="flex items-center gap-2 mb-1 text-xs">
        <span className="text-gray-500" title="Colour the matrix cells by a chosen score — red = low, green = high">Heat:</span>
        <div className="flex border rounded-lg overflow-hidden">
          {(['quality', 'trajectory', ...(anyHuman ? ['human'] : []), 'off'] as HeatMode[]).map((m) => (
            <button key={m} onClick={() => setHeat(m)} title={HEAT_HELP[m]}
              className={`px-2.5 py-1 ${heat === m ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {HEAT_LABEL[m]}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-gray-400 mb-3 max-w-3xl">
        {HEAT_HELP[heat]}
        {detail.configurations.length > 4 && (
          <span className="text-gray-400"> · {detail.configurations.length} configs — scroll horizontally to see them all →</span>
        )}
      </p>
      <table className="text-sm border-separate w-full" style={{ borderSpacing: 4 }}>
        <thead>
          <tr>
            <th className="text-left text-xs text-gray-500 px-2 sticky top-0 left-0 bg-white z-20">case \ config</th>
            {detail.configurations.map((cfg) => (
              <th key={cfg.config_key} className="text-xs text-gray-500 font-normal px-2 whitespace-nowrap sticky top-0 bg-white z-10" title={cfg.label}>
                {cfg.config_key} <span className="text-gray-400">{cfg.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.case_key}>
              <td className="text-xs text-gray-700 font-medium px-2 max-w-[16rem] truncate sticky left-0 z-10 bg-white" title={c.title}>
                {c.case_key}
              </td>
              {detail.configurations.map((cfg) => {
                const cell = cells.get(`${cfg.config_key}|${c.case_key}`)
                const counts = cell?.counts || {}
                const heatVal = heat === 'quality' ? cell?.quality_mean : heat === 'trajectory' ? cell?.trajectory_mean : heat === 'human' ? cell?.human_mean : null
                return (
                  <td key={cfg.config_key} onClick={() => onCell(cfg.config_key, c.case_key)}
                    style={heat === 'off' ? undefined : cellHeat(heatVal)}
                    className="border rounded-lg px-2 py-1.5 hover:brightness-95 cursor-pointer text-center">
                    {/* 🔩 mechanical row: run outcome + executable checker verdict */}
                    <div className="flex items-center justify-center gap-1 text-xs">
                      <span title="run outcome + executable checker (E-23)">🔩</span>
                      {counts.success ? <span className="text-green-600 font-medium">{counts.success}✓</span> : null}
                      {counts.failed ? <span className="text-red-600 font-medium">{counts.failed}✗</span> : null}
                      {counts.preprocessing ? <span className="text-purple-600 font-medium" title="preprocessing (Toolathlon seed)">{counts.preprocessing}⚙</span> : null}
                      {counts.running ? <span className="text-blue-600 font-medium">{counts.running}…</span> : null}
                      {counts.evaluating ? <span className="text-indigo-600 font-medium" title="evaluating (executable checker)">{counts.evaluating}⏳</span> : null}
                      {counts.pending ? <span className="text-gray-400">{counts.pending}·</span> : null}
                      {counts.skipped ? <span className="text-amber-600">{counts.skipped}s</span> : null}
                      {Object.keys(counts).length === 0 && <span className="text-gray-300">—</span>}
                      {cell?.external_total ? (
                        <span className={cell.external_pass === cell.external_total ? 'text-green-600' : cell.external_pass ? 'text-amber-600' : 'text-red-600'}
                          title="executable verdict — passed / evaluated (Toolathlon checker)">
                          ✔{cell.external_pass}/{cell.external_total}
                        </span>
                      ) : null}
                    </div>
                    {/* ⚖️ judge row: quality (E-02) + trajectory (E-07), always shown */}
                    {(cell?.quality_mean != null || cell?.trajectory_mean != null) && (
                      <div className="text-[10px] mt-0.5 text-gray-600 tabular-nums">
                        <span title="LLM judge — q: outcome quality (E-02) · t: process trajectory (E-07)">⚖️</span>
                        {cell?.quality_mean != null && (
                          <span className="ml-0.5"
                            title={`outcome quality — rubric score of the result (E-02 judge)${cell.quality_std != null ? ` · σ ${cell.quality_std} across runs` : ''}${fmtBreakdown(cell.dim_means) ? `\nby dimension (low→high): ${fmtBreakdown(cell.dim_means)}` : ''}`}>
                            q{cell.quality_mean}{cell.quality_std != null && <span className="text-gray-400">±{cell.quality_std}</span>}
                          </span>
                        )}
                        {cell?.trajectory_mean != null && (
                          <span className="ml-1"
                            title={`process trajectory — 6-axis score of how the agent worked (E-07 judge)${cell.trajectory_std != null ? ` · σ ${cell.trajectory_std} across runs` : ''}${fmtBreakdown(cell.axis_means) ? `\nby axis (low→high): ${fmtBreakdown(cell.axis_means)}` : ''}`}>
                            t{cell.trajectory_mean}{cell.trajectory_std != null && <span className="text-gray-400">±{cell.trajectory_std}</span>}
                          </span>
                        )}
                      </div>
                    )}
                    {/* 🧑 human row: mean dimension score + verdict (E-05) */}
                    {cell?.human_rated ? (
                      <div className="text-[10px] mt-0.5 text-gray-600 tabular-nums" title="human annotation (E-05): mean dimension score + verdict">
                        <span>🧑</span>
                        {cell.human_mean != null && <span className="ml-0.5">{cell.human_mean}{cell.human_std != null && <span className="text-gray-400">±{cell.human_std}</span>}</span>}
                        <span className={`ml-0.5 ${cell.human_approve === cell.human_rated ? 'text-green-600' : cell.human_approve ? 'text-amber-600' : 'text-red-600'}`}
                          title={`${cell.human_approve}/${cell.human_rated} approved`}>
                          {cell.human_approve === cell.human_rated ? '✓' : cell.human_approve ? '~' : '✗'}
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
      <div className="text-xs text-gray-400 mt-2">🔩 run outcome + ✔pass/total executable checker (✓ success · ✗ failed · ⚙ preprocessing · … running · ⏳ evaluating · · pending · s skipped) · ⚖️ LLM judge (q = outcome quality E-02 · t = process trajectory E-07) · 🧑 human (mean score + ✓/✗ verdict, E-05) · ±σ = spread across runs · hover q/t for the per-dimension/axis breakdown — click a cell for run details</div>
      {anyHuman && triPoints.length >= 2 && (
        <div className="mt-6 border-t pt-4">
          <div className="text-sm font-medium text-gray-700 mb-1">
            ⚖️ Judge ↔ 🧑 Human
            <span className="text-xs text-gray-400 font-normal"> · per cell · E-02 quality vs E-05 human · points on the dashed diagonal = agreement</span>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 24, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" dataKey="judge" name="judge" domain={[0, 10]} tick={{ fontSize: 11 }}
                label={{ value: '⚖️ judge quality (E-02)', position: 'insideBottom', offset: -12, fontSize: 11 }} />
              <YAxis type="number" dataKey="human" name="human" domain={[0, 10]} tick={{ fontSize: 11 }}
                label={{ value: '🧑 human (E-05)', angle: -90, position: 'insideLeft', fontSize: 11 }} />
              <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 10, y: 10 }]} stroke="#9ca3af" strokeDasharray="4 4" />
              <Tooltip cursor={{ strokeDasharray: '3 3' }}
                content={({ payload }) => (payload && payload.length ? (
                  <div className="bg-white border rounded px-2 py-1 text-xs shadow">
                    <div className="font-medium">{payload[0].payload.label}</div>
                    <div>⚖️ {payload[0].payload.judge} · 🧑 {payload[0].payload.human} · checker {payload[0].payload.checker}</div>
                  </div>
                ) : null)} />
              <Scatter data={triPoints}>
                {triPoints.map((p, i) => (
                  <Cell key={i} fill={p.checker === 'fail' ? '#dc2626' : p.checker === 'pass' ? '#16a34a' : '#3b82f6'} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
          <div className="text-xs text-gray-400 mt-1">
            {verifiable ? '🟢 checker ✓ · 🔴 checker ✗ · ' : ''}🔵 no checker · dashed = perfect agreement. Points well ABOVE the diagonal where 🔴 = checker false-negatives (judge + human say good, checker failed).
          </div>
        </div>
      )}
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

// Per-experiment judge↔human calibration (E-17), scoped to THIS experiment's
// annotated runs — distinct from the workspace-global JudgeTrustBadge. Empty state
// guides the user to annotate runs (Annotate tab in a run drill-down) so the κ
// becomes about this experiment instead of prior ones.
function JudgeHumanCalibration({ cal }: { cal?: ExperimentReport['judge_calibration'] }) {
  const k = cal?.overall?.cohen_kappa
  const agree = cal?.overall?.agreement_pct
  const hasData = !!cal?.available && (cal?.sample_size ?? 0) > 0
  return (
    <section>
      <h3 className="font-semibold text-gray-900 mb-2">
        Judge ↔ human <span className="text-xs text-gray-400 font-normal">E-17 · agreement on this experiment's annotated runs</span>
      </h3>
      {!hasData ? (
        <div className="bg-white border rounded-lg p-4 text-sm text-gray-500">
          No human ratings on this experiment yet. Open a run (click a matrix cell) → <span className="font-medium">Annotate</span> tab,
          score the same dimensions the judge did, and this section will show how well the LLM judge agrees with you (Cohen's κ,
          per-dimension correlation). The workspace badge above mixes all experiments; this one is scoped to these runs only.
        </div>
      ) : (
        <div className="bg-white border rounded-lg p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <span>Overall <span className="font-semibold text-gray-800">κ {k == null ? '—' : k.toFixed(2)}</span>
              {cal?.overall?.reliable ? <span className="text-green-700"> ✓ reliable</span> : <span className="text-amber-600"> ⚠ below {cal?.threshold_kappa}</span>}</span>
            <span className="text-gray-500">verdict agreement {agree == null ? '—' : `${(agree * 100).toFixed(0)}%`}</span>
            <span className="text-gray-400">{cal?.n_records} annotated run(s) · {cal?.sample_size} dim-ratings · {cal?.n_humans} annotator(s)</span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
              <tr>
                <th className="px-3 py-2">Dimension</th>
                <th className="px-3 py-2">n</th>
                <th className="px-3 py-2" title="Cohen's kappa — chance-corrected agreement on the verdict (0–1; ≥ threshold = reliable)">κ</th>
                <th className="px-3 py-2" title="Pearson correlation, judge vs human scores (−1…1; 1 = perfect linear agreement)">Pearson</th>
                <th className="px-3 py-2" title="Spearman rank correlation, judge vs human scores (−1…1)">Spearman</th>
                <th className="px-3 py-2" title="judge − human mean; 0 = unbiased, + = judge over-credits, − = under-credits (±0.5 signals bias)">Bias</th>
                <th className="px-3 py-2">Reliable</th>
              </tr>
            </thead>
            <tbody>
              {cal!.dimensions.map((d) => (
                <tr key={d.key} className="border-t">
                  <td className="px-3 py-2 text-gray-700">{d.name}</td>
                  <td className="px-3 py-2 text-gray-500">{d.n}</td>
                  <td className="px-3 py-2">{d.cohen_kappa == null ? '—' : d.cohen_kappa.toFixed(2)}</td>
                  <td className="px-3 py-2">{d.pearson == null ? '—' : d.pearson.toFixed(2)}</td>
                  <td className="px-3 py-2">{d.spearman == null ? '—' : d.spearman.toFixed(2)}</td>
                  <td className={`px-3 py-2 ${(d.mean_bias ?? 0) > 0.5 ? 'text-amber-600' : (d.mean_bias ?? 0) < -0.5 ? 'text-blue-600' : 'text-gray-500'}`}>
                    {d.mean_bias == null ? '—' : (d.mean_bias > 0 ? '+' : '') + d.mean_bias.toFixed(1)}
                  </td>
                  <td className="px-3 py-2">
                    {d.status === 'insufficient_data'
                      ? <span className="text-gray-400" title="need ≥3 ratings">n/a</span>
                      : d.reliable ? <span className="text-green-700">✓</span> : <span className="text-amber-600">⚠</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
  // Verifiable bench (executable checker = outcome ground truth): the outcome
  // judge (E-02) is not the eval — it's the audited subject. Hide its scores
  // (Summary "Quality" column + the weighted_score/dim:* significance rows) and
  // keep only the trajectory (E-07) signal. (SPA-68)
  const verifiable = !!report.external?.available
  const isOutcomeMetric = (m: string) => m === 'weighted_score' || m.startsWith('dim:')
  const visibleSignificance = verifiable
    ? report.significance.filter((s) => !isOutcomeMetric(s.metric))
    : report.significance
  // Cost-breakdown columns: agent + the two core judges (E-02/E-07) always show —
  // on verifiable benches a $0 agent (providers that don't price per-token) next to
  // a non-zero hidden E-02 judge IS the point. The optional judges (E-08/E-14/E-15)
  // appear only when they actually spent, so the table stays readable.
  const COST_COLS: { key: keyof ExperimentCostRow; label: string; core?: boolean }[] = [
    { key: 'agent', label: 'Agent', core: true },
    { key: 'judge_outcome', label: 'Quality (E-02)', core: true },
    { key: 'judge_trajectory', label: 'Trajectory (E-07)', core: true },
    { key: 'judge_evidence', label: 'Evidence (E-08)' },
    { key: 'judge_failure', label: 'Failure (E-14)' },
    { key: 'judge_hallucination', label: 'Hallucination (E-15)' },
  ]
  const cb = report.cost_breakdown
  const activeCostCols = cb
    ? COST_COLS.filter((c) => c.core || (cb.totals[c.key] as number) > 0)
    : []
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
                {!verifiable && <th className="px-3 py-2">Quality</th>}
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
                  {!verifiable && <td className="px-3 py-2">{fmt(c.quality_mean)}</td>}
                  <td className="px-3 py-2">{fmt(c.trajectory_mean)}</td>
                  <td className="px-3 py-2">${fmt(c.cost_mean, 3)}</td>
                  <td className="px-3 py-2">{c.duration_mean != null ? `${Math.round(c.duration_mean)}s` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {cb?.available && activeCostCols.length > 0 && (
        <section>
          <h3 className="font-semibold text-gray-900 mb-2">
            Cost breakdown <span className="text-xs text-gray-400 font-normal">where the eval spend went — agent execution vs each judge (USD){verifiable ? ' · the outcome judge (E-02) still costs even when its scores are hidden' : ''}</span>
          </h3>
          <div className="bg-white border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-3 py-2">Configuration</th>
                  {activeCostCols.map((c) => <th key={c.key} className="px-3 py-2">{c.label}</th>)}
                  <th className="px-3 py-2">Total</th>
                </tr>
              </thead>
              <tbody>
                {cb.per_config.map((row) => (
                  <tr key={row.config_key} className="border-t">
                    <td className="px-3 py-2 font-medium">{row.config_key} <span className="text-gray-500 font-normal">{row.label}</span></td>
                    {activeCostCols.map((c) => (
                      <td key={c.key} className="px-3 py-2 text-gray-600">{fmtUsd(row[c.key] as number)}</td>
                    ))}
                    <td className="px-3 py-2 font-semibold">{fmtUsd(row.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-gray-50">
                  <td className="px-3 py-2 font-medium">All configs</td>
                  {activeCostCols.map((c) => (
                    <td key={c.key} className="px-3 py-2 font-medium">{fmtUsd(cb.totals[c.key] as number)}</td>
                  ))}
                  <td className="px-3 py-2 font-bold">{fmtUsd(cb.totals.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-[11px] text-gray-400 mt-1 max-w-3xl">
            Agent execution includes orchestrator overhead when enabled (not metered separately). Judge columns are each
            evaluator's <code>judge_cost_usd</code>; an evaluator with zero spend across all configs is hidden.
          </p>
        </section>
      )}

      {report.external?.available ? (
        <section>
          <h3 className="font-semibold text-gray-900 mb-2">Quality profile heatmap</h3>
          <p className="text-sm text-gray-500">
            Outcome is verified by the executable checker (ground truth) — the outcome judge
            (E-02) is not used on verifiable benches. See the Executable pass-rate section below.
          </p>
        </section>
      ) : (
      <section>
        <h3 className="font-semibold text-gray-900 mb-2">
          Quality profile heatmap <span className="text-xs text-gray-400 font-normal">per-dimension outcome judge (E-02), success-only</span>
        </h3>
        {report.heatmap.dimensions.length === 0 ? (
          <p className="text-sm text-gray-500">No rubric dimension scores yet (configure a judge model to score runs).</p>
        ) : (
          <div className="bg-white border rounded-lg overflow-x-auto p-3">
            <table className="text-sm border-separate" style={{ borderSpacing: 3 }}>
              <thead>
                <tr>
                  <th className="text-left text-xs text-gray-500 px-2">config</th>
                  {report.heatmap.dimensions.map((d) => (
                    <th key={d} className="text-xs text-gray-500 font-normal px-2" title={report.heatmap.dimension_labels?.[d]}>
                      {(report.heatmap.dimension_labels?.[d] || d).replace(/_/g, ' ')}
                    </th>
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
      )}

      {!verifiable && report.quality_gate?.available && (
        <section>
          <h3 className="font-semibold text-gray-900 mb-2">
            Quality gate <span className="text-xs text-gray-400 font-normal">share of outcome-scored runs that cleared the E-02 critical rubric thresholds · success or failed</span>
          </h3>
          <div className="bg-white border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-3 py-2">Configuration</th>
                  <th className="px-3 py-2" title="share of scored runs whose result passed every CRITICAL rubric dimension (higher is better)">Gate pass</th>
                  <th className="px-3 py-2">Passed</th>
                  <th className="px-3 py-2">Scored</th>
                  <th className="px-3 py-2" title="rubric dimensions that most often fail the gate (count of runs)">Top failing dimensions</th>
                </tr>
              </thead>
              <tbody>
                {report.quality_gate.per_config.map((c) => {
                  const failed = Object.entries(c.failed_dimensions).sort((a, b) => b[1] - a[1])
                  return (
                    <tr key={c.config_key} className="border-t align-top">
                      <td className="px-3 py-2 font-medium">{c.config_key} <span className="text-gray-500 font-normal">{c.label}</span></td>
                      <td className="px-3 py-2 font-semibold">{c.pass_rate != null ? `${(c.pass_rate * 100).toFixed(0)}%` : '—'}</td>
                      <td className="px-3 py-2 text-green-700">{c.n_pass}</td>
                      <td className="px-3 py-2 text-gray-500">{c.n}</td>
                      <td className="px-3 py-2 text-gray-600">
                        {failed.length
                          ? failed.map(([d, n]) => `${(report.heatmap.dimension_labels?.[d] || d).replace(/_/g, ' ')}: ${n}`).join(' · ')
                          : <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

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

      {report.loop_detection?.available && (
        <section>
          <h3 className="font-semibold text-gray-900 mb-2">
            Loop detection <span className="text-xs text-gray-400 font-normal">share of trajectory-scored runs the process judge flagged as looping (E-07) · success or failed · lower is better</span>
          </h3>
          <div className="bg-white border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-3 py-2">Configuration</th>
                  <th className="px-3 py-2" title="share of trajectory-scored runs flagged as looping — the agent repeating the same call until it caps (lower is better)">Loop rate</th>
                  <th className="px-3 py-2">Looped</th>
                  <th className="px-3 py-2">Scored</th>
                </tr>
              </thead>
              <tbody>
                {report.loop_detection.per_config.map((c) => (
                  <tr key={c.config_key} className="border-t">
                    <td className="px-3 py-2 font-medium">{c.config_key} <span className="text-gray-500 font-normal">{c.label}</span></td>
                    <td className={`px-3 py-2 font-semibold ${(c.loop_rate ?? 0) > 0 ? 'text-amber-600' : 'text-gray-700'}`}>
                      {c.loop_rate != null ? `${(c.loop_rate * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td className="px-3 py-2 text-gray-600">{c.n_loop}</td>
                    <td className="px-3 py-2 text-gray-500">{c.n_scored}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report.human_feedback?.available && (
        <section>
          <h3 className="font-semibold text-gray-900 mb-2">
            Human feedback profile <span className="text-xs text-gray-400 font-normal">per-dimension E-05 human ratings · all rated runs · the third oracle</span>
          </h3>
          <div className="bg-white border rounded-lg overflow-x-auto p-3">
            <table className="text-sm border-separate" style={{ borderSpacing: 3 }}>
              <thead>
                <tr>
                  <th className="text-left text-xs text-gray-500 px-2">config</th>
                  {report.human_feedback.dimensions.map((d) => (
                    <th key={d} className="text-xs text-gray-500 font-normal px-2" title={report.human_feedback!.dimension_labels[d]}>
                      {(report.human_feedback!.dimension_labels[d] || d).replace(/_/g, ' ')}
                    </th>
                  ))}
                  <th className="text-xs text-gray-700 font-medium px-2">overall</th>
                  <th className="text-xs text-gray-500 font-normal px-2" title="approve / reject verdicts on the rated runs (· = rated, no verdict)">verdict</th>
                </tr>
              </thead>
              <tbody>
                {report.human_feedback.rows.map((row) => (
                  <tr key={row.config_key}>
                    <td className="text-xs font-medium px-2 whitespace-nowrap" title={row.label}>{row.config_key}</td>
                    {report.human_feedback!.dimensions.map((d) => {
                      const cell = row.cells[d]
                      return (
                        <td key={d} className="rounded px-3 py-2 text-center text-sm font-medium" style={heatStyle(cell?.mean)}
                          title={cell ? `n=${cell.n}${cell.std != null ? ` · std=${cell.std}` : ''}` : ''}>
                          {fmt(cell?.mean, 1)}
                        </td>
                      )
                    })}
                    <td className="rounded px-3 py-2 text-center text-sm font-bold" style={heatStyle(row.overall_score.mean)}
                      title={`n=${row.overall_score.n}${row.overall_score.std != null ? ` · std=${row.overall_score.std}` : ''}`}>
                      {fmt(row.overall_score.mean, 1)}
                    </td>
                    <td className="px-2 text-center text-xs whitespace-nowrap">
                      {row.n_rated === 0 ? <span className="text-gray-300">—</span> : (
                        <span title={`${row.n_rated} rated run(s)`}>
                          {row.verdicts.approve > 0 && <span className="text-green-700">{row.verdicts.approve}✓</span>}
                          {row.verdicts.reject > 0 && <span className="text-red-700 ml-1">{row.verdicts.reject}✗</span>}
                          {row.verdicts.none > 0 && <span className="text-gray-400 ml-1">{row.verdicts.none}·</span>}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-400 mt-1 max-w-3xl">
            Raw human signal (E-05) — independent of the judge↔human agreement (E-17) below. Aggregated over every rated
            run (not success-only), so the verdict counts keep the rejects. Cells colour low→high like the judge heatmaps; hover for n / σ.
          </p>
        </section>
      )}

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
                  <th className="px-3 py-2" title="% of scored runs whose trajectory matches the canonical gold trajectory within threshold">Match rate</th>
                  <th className="px-3 py-2" title="mean trajectory similarity to the gold trajectory (0–1; higher = closer)">Score mean</th>
                  <th className="px-3 py-2" title="runs that had a canonical gold trajectory to score against">Scored</th>
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

      {!report.external?.available && report.rq2?.available && (
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
            <p className="text-[11px] text-gray-400 mt-2">
              Diagonal (green/red) = judge agrees with the executable checker; off-diagonal (amber) = disagreement.
              The <span className="text-amber-700">fail × judge-high</span> cell is the over-credit signal — the judge rewarding a
              result the checker rejected. This is the outcome-judge analogue of the human-calibrated κ in <span className="font-medium">Judge ↔ human</span> below (E-17).
            </p>
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {!verifiable && (
          <SummaryRadarPanel
            title="Quality profile"
            subtitle="overlay · per-config E-02 dimensions (success-only) — toggle configs"
            axes={report.heatmap.dimensions}
            axisLabel={(k) => report.heatmap.dimension_labels?.[k] ?? k.replace(/_/g, ' ')}
            rows={report.heatmap.rows}
            colorOf={(k) => colorByConfig.get(k)}
          />
        )}
        <SummaryRadarPanel
          title="Trajectory profile"
          subtitle="overlay · per-config E-07 axes (success-only) — toggle configs"
          axes={report.trajectory_heatmap.axes}
          axisLabel={(k) => report.trajectory_heatmap.axis_labels?.[k] ?? k.replace(/_/g, ' ')}
          rows={report.trajectory_heatmap.rows}
          colorOf={(k) => colorByConfig.get(k)}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section>
          <h3 className="font-semibold text-gray-900 mb-2">Pareto frontier <span className="text-xs text-gray-400 font-normal">quality × cost · bubble size = wall-clock time · <span className="text-green-700">green</span> = on the frontier (no config beats it on all of quality/cost/time), grey = dominated{verifiable ? ' · *E-02 audited, not evaluator' : ''}</span></h3>
          <div className="bg-white border rounded-lg p-3 h-72">
            {new Set(report.pareto.points.map((p) => p.cost)).size <= 1 ? (
              <div className="h-full flex items-center justify-center text-center text-xs text-gray-400 px-6">
                Cost is identical across configs (${(report.pareto.points[0]?.cost ?? 0).toFixed(3)}) — these
                providers don't expose per-token pricing, so a quality × cost frontier is degenerate. Compare
                quality via the leaderboard and heatmap instead.
              </div>
            ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 20, bottom: 28, left: 12 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" dataKey="cost" name="cost" unit="$" tick={{ fontSize: 11 }}
                  label={{ value: 'Cost ($)', position: 'insideBottom', offset: -12, fontSize: 11, fill: '#6b7280' }} />
                <YAxis type="number" dataKey="quality" name="quality" domain={[0, 10]} tick={{ fontSize: 11 }}
                  label={{ value: verifiable ? 'Quality (E-02)*' : 'Quality (E-02)', angle: -90, position: 'insideLeft', fontSize: 11, fill: '#6b7280' }} />
                <ZAxis type="number" dataKey="time" range={[60, 400]} name="time" unit="s" />
                <Tooltip cursor={{ strokeDasharray: '3 3' }}
                  content={({ payload }) => (payload && payload.length ? (
                    <div className="bg-white border rounded px-2 py-1 text-xs shadow">
                      <div className="font-medium">{payload[0].payload.label}</div>
                      <div>quality {fmt(payload[0].payload.quality, 1)} · ${fmt(payload[0].payload.cost, 3)} · {payload[0].payload.time != null ? `${Math.round(payload[0].payload.time)}s` : '—'}{payload[0].payload.on_frontier ? ' · frontier' : ''}</div>
                    </div>
                  ) : null)} />
                <Legend />
                <Scatter name="frontier" data={report.pareto.points.filter((p) => p.on_frontier)} fill="#16a34a">
                  <LabelList dataKey="label" position="top" offset={8} fontSize={11} fill="#15803d" />
                </Scatter>
                <Scatter name="dominated" data={report.pareto.points.filter((p) => !p.on_frontier)} fill="#9ca3af">
                  <LabelList dataKey="label" position="top" offset={8} fontSize={11} fill="#6b7280" />
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
            )}
          </div>
        </section>

        <section>
          <h3 className="font-semibold text-gray-900 mb-2">Outcome × Trajectory <span className="text-xs text-gray-400 font-normal">per run{verifiable ? ' · *outcome E-02 audited, not evaluator' : ''}</span></h3>
          <div className="bg-white border rounded-lg p-3 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 20, bottom: 28, left: 12 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" dataKey="outcome" name="outcome" domain={[0, 10]} tick={{ fontSize: 11 }}
                  label={{ value: verifiable ? 'Outcome (E-02)*' : 'Outcome (E-02)', position: 'insideBottom', offset: -12, fontSize: 11, fill: '#6b7280' }} />
                <YAxis type="number" dataKey="trajectory" name="trajectory" domain={[0, 10]} tick={{ fontSize: 11 }}
                  label={{ value: 'Trajectory (E-07)', angle: -90, position: 'insideLeft', fontSize: 11, fill: '#6b7280' }} />
                <Tooltip cursor={{ strokeDasharray: '3 3' }}
                  content={({ payload }) => (payload && payload.length ? (
                    <div className="bg-white border rounded px-2 py-1 text-xs shadow">
                      <div className="font-medium">{payload[0].payload.label} · {payload[0].payload.case_key} · #{(payload[0].payload.run_index ?? 0) + 1}</div>
                      <div>
                        {verifiable ? 'outcome*' : 'outcome'} {fmt(payload[0].payload.outcome, 1)} · trajectory {fmt(payload[0].payload.trajectory, 1)} ·{' '}
                        <span className={payload[0].payload.status === 'failed' ? 'text-red-600' : 'text-gray-500'}>{payload[0].payload.status}</span>
                      </div>
                    </div>
                  ) : null)} />
                <Legend />
                {report.summary.per_config.map((c) => (
                  <Scatter key={c.config_key} name={c.config_key}
                    data={report.scatter.filter((p) => p.config_key === c.config_key && p.status !== 'failed' && p.outcome != null && p.trajectory != null)}
                    fill={colorByConfig.get(c.config_key)} />
                ))}
                <Scatter name="failed (any model)" shape="cross"
                  data={report.scatter.filter((p) => p.status === 'failed' && p.outcome != null && p.trajectory != null)}
                  fill="#9ca3af" />
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
        {verifiable && (
          <p className="text-xs text-gray-400 mb-2 -mt-1 max-w-3xl">
            On verifiable benches the outcome judge (E-02) is the subject being audited (not the evaluator), so its metrics
            (Overall quality + dimensions) are hidden here — only Trajectory (E-07) is shown. See <span className="font-medium">Executable pass-rate</span> above for the ground-truth outcome.
          </p>
        )}
        {visibleSignificance.length > 0 && (
          <p className="text-xs text-gray-400 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>Judge:</span>
            <span className="px-1.5 py-0.5 rounded font-medium text-blue-700 bg-blue-50">Quality (E-02)</span>
            <span>= outcome rubric ·</span>
            <span className="px-1.5 py-0.5 rounded font-medium text-purple-700 bg-purple-50">Trajectory (E-07)</span>
            <span>= process, 6-axis. Rows are grouped by evaluator.</span>
          </p>
        )}
        {visibleSignificance.length === 0 ? (
          <p className="text-sm text-gray-500">Not enough samples per cell yet (need n ≥ 3 scored runs on both sides).</p>
        ) : (
          <div className="bg-white border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-3 py-2">Pair</th>
                  <th className="px-3 py-2">Metric</th>
                  <th className="px-3 py-2" title="which evaluator produced this metric — outcome judge (E-02) or process judge (E-07)">Judge</th>
                  <th className="px-3 py-2">Welch p</th>
                  <th className="px-3 py-2">Mann-Whitney p</th>
                  <th className="px-3 py-2">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {[...visibleSignificance]
                  .sort((x, y) =>
                    metricJudge(x.metric).label.localeCompare(metricJudge(y.metric).label) ||
                    metricLabel(x.metric).localeCompare(metricLabel(y.metric)) ||
                    `${x.a}${x.b}`.localeCompare(`${y.a}${y.b}`))
                  .map((s) => {
                    const judge = metricJudge(s.metric)
                    return (
                      <tr key={`${s.a}-${s.b}-${s.metric}`} className="border-t">
                        <td className="px-3 py-2">{s.a} vs {s.b}</td>
                        <td className="px-3 py-2 text-gray-700">{metricLabel(s.metric)}</td>
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${judge.cls}`}>{judge.label}</span>
                        </td>
                        <td className="px-3 py-2">{s.welch ? s.welch.p.toFixed(4) : '—'}</td>
                        <td className="px-3 py-2">{s.mann_whitney ? s.mann_whitney.p.toFixed(4) : '—'}</td>
                        <td className="px-3 py-2">
                          {s.significant
                            ? <span className="text-green-700 font-medium">★ significant</span>
                            : <span className="text-gray-400">not significant</span>}
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <JudgeHumanCalibration cal={report.judge_calibration} />

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
                      {Object.keys(f.classes).length === 0 ? '—' : (
                        <ul className="space-y-1">
                          {Object.entries(f.classes).sort((a, b) => b[1] - a[1]).map(([c, n]) => (
                            <li key={c}>
                              <span className="font-medium text-gray-700">{c.replace(/_/g, ' ')}</span>
                              <span className="text-gray-400"> ×{n}</span>
                              {f.class_reasons?.[c]?.length ? (
                                <ul className="ml-3 mt-0.5 list-disc list-inside text-xs text-gray-500 space-y-0.5">
                                  {f.class_reasons[c].map((r, i) => (
                                    <li key={i} title={r.confidence != null ? `confidence ${r.confidence}` : undefined}>{r.reason}</li>
                                  ))}
                                </ul>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
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
  // Verifiable bench (executable checker = outcome ground truth): the outcome
  // judge (E-02) is the audited subject, not the eval — hide its score column. (SPA-68)
  const verifiable = detail.matrix.some((c) => (c.external_total ?? 0) > 0)
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
              {!verifiable && <th className="px-3 py-2">Quality</th>}
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
                    {!verifiable && <td className="px-3 py-2">{fmt(r.weighted_score, 1)}</td>}
                    <td className="px-3 py-2">{fmt(r.trajectory_score, 1)}</td>
                    <td className="px-3 py-2">${r.cost_usd.toFixed(3)}</td>
                    <td className="px-3 py-2">{r.duration_seconds != null ? `${r.duration_seconds}s` : '—'}</td>
                    <td className="px-3 py-2 text-gray-500 max-w-md truncate" title={r.result_summary || ''}>
                      {r.result_summary || '—'}
                    </td>
                  </tr>
                  {open && r.task_id && (
                    <tr className="border-t bg-gray-50">
                      <td colSpan={verifiable ? 8 : 9} className="px-3 py-3">
                        <div className="max-w-[68rem] min-w-0 sticky left-0">
                          <RunAnalysis
                            taskId={r.task_id}
                            profile={r.quality_profile ?? null}
                            verifiable={verifiable}
                            onSaved={() => setOpenTask(null)}
                          />
                        </div>
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
  const retryFailedMutation = useMutation({ mutationFn: () => experimentsApi.retryFailed(id), onSuccess: invalidate })
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
  const failedCount = (detail.matrix ?? []).reduce((s, c) => s + (c.counts?.failed ?? 0), 0)

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
          {isTerminal && failedCount > 0 && (
            <button onClick={() => { if (confirm(`Re-run ${failedCount} failed cell(s) in place (rate-limit / API / infra errors)? Valid cells and their scores are kept.`)) retryFailedMutation.mutate() }}
              disabled={retryFailedMutation.isPending}
              title="Reset only the failed cells to pending and re-run them in THIS experiment — no clone, valid cells untouched. Repeatable across provider quota windows."
              className="flex items-center gap-1.5 px-3 py-2 border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 text-sm font-medium">
              <RotateCcw className="h-4 w-4" /> Retry failed ({failedCount})
            </button>
          )}
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

import { useState } from 'react'
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import { Target, ShieldCheck, ShieldAlert } from 'lucide-react'
import type { QualityProfile, QualityProfileDimension } from '@/types'
import { cn } from '@/lib/utils'

/** Outcome judge (E-02): per-dimension quality of the deliverables, rendered with
 *  the same radar + per-axis reasoning layout as the trajectory panel (E-07). Uses
 *  the quality_profile already loaded for the run — when outcome_files_only is set
 *  the judge graded the deliverable files only (no agent self-report). */
export default function OutcomeScorePanel({ profile }: { profile: QualityProfile | null }) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50"
      >
        <Target className="h-4 w-4" />
        Outcome score
      </button>
    )
  }

  return (
    <div className="mt-2 border rounded-lg p-3 bg-gray-50 space-y-3 min-w-0">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700">
          Outcome score{profile?.rubric_name ? ` · ${profile.rubric_name}` : ''}
        </h4>
        <button onClick={() => setOpen(false)} className="text-xs text-gray-400 hover:underline">
          close
        </button>
      </div>

      {profile ? (
        <OutcomeView profile={profile} />
      ) : (
        <p className="text-xs text-gray-400">Not yet judged.</p>
      )}
    </div>
  )
}

const dimLabel = (d: QualityProfileDimension) =>
  d.evaluator === 'reference' && d.reference_mode
    ? `${d.name} (${d.reference_mode})`
    : d.evaluator === 'objective' && d.probe
      ? `${d.name} (${d.probe})`
      : d.name

function OutcomeView({ profile }: { profile: QualityProfile }) {
  const scored = profile.dimensions.filter((d) => d.status === 'scored' && d.score != null)
  const data = scored.map((d) => ({ axis: dimLabel(d), score: d.score as number }))

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm">
          Weighted:{' '}
          <span className="font-medium text-gray-700">
            {profile.weighted_score != null ? `${profile.weighted_score}/10` : '—'}
          </span>
        </span>
        <span
          className={cn(
            'flex items-center gap-1 text-xs px-2 py-0.5 rounded-full',
            profile.gate.passed ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700',
          )}
          title={
            profile.gate.passed
              ? 'All critical dimensions meet their thresholds'
              : `Below threshold: ${profile.gate.failed_dimensions.join(', ')}`
          }
        >
          {profile.gate.passed ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
          {profile.gate.passed ? 'Gate passed' : 'Gate failed'}
        </span>
      </div>

      {data.length >= 3 && (
        <div style={{ width: '100%', height: 260 }}>
          <ResponsiveContainer>
            <RadarChart data={data} outerRadius="70%">
              <PolarGrid />
              <PolarAngleAxis dataKey="axis" tick={{ fontSize: 11, fill: '#6b7280' }} />
              <PolarRadiusAxis domain={[0, 10]} tick={{ fontSize: 10, fill: '#9ca3af' }} />
              <Radar name="Score" dataKey="score" stroke="#2563eb" fill="#3b82f6" fillOpacity={0.5} />
              <Tooltip />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Per-dimension scores + reasons */}
      <div className="space-y-1.5">
        {scored.map((d) => (
          <div key={d.key} className="text-xs min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-700">
                {dimLabel(d)}
                {d.critical && (
                  <span className="text-amber-600" title="critical dimension — gates the run">
                    {' '}
                    *
                  </span>
                )}
              </span>
              <span className="font-medium shrink-0">{d.score}/10</span>
            </div>
            {d.reasoning && <p className="text-gray-500 break-words">{d.reasoning}</p>}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        <span>Judge: {profile.judge_model}</span>
        <span>${profile.judge_cost_usd.toFixed(4)}</span>
        <span>
          {profile.judge_input_tokens.toLocaleString()} in · {profile.judge_output_tokens.toLocaleString()} out
        </span>
      </div>
    </>
  )
}

import type { DecompositionResponse, AttemptOutcome } from '@/types'

const OUTCOME_COLOR: Record<AttemptOutcome, string> = {
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  aborted: 'bg-orange-500',
  running: 'bg-blue-400 animate-pulse',
}

const ROW_HEIGHT = 22 // px
const LABEL_WIDTH = 200 // px
const TICKS = 6

function fmtTime(d: Date): string {
  return d.toISOString().slice(11, 19) // HH:MM:SS UTC
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

interface Props {
  data: DecompositionResponse
}

export default function DecompositionGantt({ data }: Props) {
  const allTimes: number[] = []
  for (const s of data.subtasks) {
    for (const a of s.attempts) {
      allTimes.push(new Date(a.spawned_at).getTime())
      if (a.finished_at) allTimes.push(new Date(a.finished_at).getTime())
    }
  }

  if (allTimes.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        No agent attempts recorded yet for this decomposition.
      </p>
    )
  }

  const tMin = Math.min(...allTimes)
  const tMax = Math.max(...allTimes, Date.now())
  const span = Math.max(1, tMax - tMin)

  const ticks = Array.from({ length: TICKS }, (_, i) => tMin + (span * i) / (TICKS - 1))

  return (
    <div className="rounded border border-gray-200 bg-white">
      <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2 text-xs text-gray-600">
        <span className="font-medium text-gray-700">Timeline</span>
        <span>span: {fmtDuration(span)}</span>
        <div className="ml-auto flex items-center gap-3">
          {(['completed', 'failed', 'aborted', 'running'] as AttemptOutcome[]).map((o) => (
            <span key={o} className="flex items-center gap-1">
              <span className={'inline-block h-2 w-3 rounded ' + OUTCOME_COLOR[o]} />
              {o}
            </span>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="relative" style={{ minWidth: 600 }}>
          <div className="flex border-b border-gray-100" style={{ paddingLeft: LABEL_WIDTH }}>
            <div className="relative h-6 flex-1 text-[10px] text-gray-400">
              {ticks.map((t, i) => (
                <span
                  key={i}
                  className="absolute top-1"
                  style={{
                    left: `${(i / (TICKS - 1)) * 100}%`,
                    transform: i === 0 ? 'translateX(0)' : i === TICKS - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
                  }}
                >
                  {fmtTime(new Date(t))}
                </span>
              ))}
            </div>
          </div>

          {data.subtasks.map((s) => {
            return (
              <div key={s.id} className="flex border-b border-gray-50 last:border-b-0">
                <div
                  className="flex shrink-0 items-center truncate border-r border-gray-100 px-3 text-xs text-gray-700"
                  style={{ width: LABEL_WIDTH, height: ROW_HEIGHT + 4 }}
                  title={s.title}
                >
                  {s.title}
                </div>
                <div
                  className="relative flex-1"
                  style={{ height: ROW_HEIGHT + 4 }}
                >
                  {s.attempts.map((a) => {
                    const start = new Date(a.spawned_at).getTime()
                    const end = a.finished_at ? new Date(a.finished_at).getTime() : tMax
                    const left = ((start - tMin) / span) * 100
                    const widthPct = ((end - start) / span) * 100
                    const dur = fmtDuration(end - start)
                    const errPart = a.error ? ` — ${a.error}` : ''
                    return (
                      <div
                        key={a.agent_container_id}
                        className={'absolute rounded ' + OUTCOME_COLOR[a.outcome]}
                        style={{
                          left: `${left}%`,
                          width: `max(4px, ${widthPct}%)`,
                          top: 4,
                          height: ROW_HEIGHT - 4,
                        }}
                        title={`${a.agent_container_id.slice(0, 12)}: ${a.outcome} (${dur})${errPart}`}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

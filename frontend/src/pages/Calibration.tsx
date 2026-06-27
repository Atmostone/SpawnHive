import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, ChevronDown, ChevronRight, Check } from 'lucide-react'
import { qualityApi } from '@/api/client'
import { cn } from '@/lib/utils'
import AnnotationPanel from '@/components/quality/AnnotationPanel'
import type { CalibrationQueueItem } from '@/types'

/** Calibration queue (E-17): annotate task results that already have a judge
 *  profile but no human feedback yet. Lives in Experiments mode — the only UI
 *  path to rate experiment-origin tasks, which the task board hides. */

type Filter = 'pending' | 'all'

export default function Calibration() {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<Filter>('pending')
  const [openTask, setOpenTask] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['calibration-queue', filter],
    queryFn: () => qualityApi.getCalibrationQueue({ status: filter, limit: 500 }),
  })

  const items = data?.items ?? []
  const pct = data && data.total > 0 ? Math.round((data.done / data.total) * 100) : 0

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center gap-2 mb-1">
        <ClipboardCheck className="h-6 w-6 text-gray-700" />
        <h1 className="text-2xl font-bold text-gray-900">Calibration</h1>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Rate task results against their rubric axes. Your feedback pairs with the judge's
        scores to calibrate the LLM judge. Includes experiment runs, which are hidden
        from the task board.
      </p>

      {data && (
        <div className="mb-4">
          <div className="flex items-center justify-between text-sm mb-1">
            <span className="text-gray-600">
              Annotated <span className="font-semibold text-gray-900">{data.done}</span> of {data.total}
            </span>
            <div className="flex items-center gap-1">
              {(['pending', 'all'] as Filter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    'px-2.5 py-1 rounded text-xs',
                    filter === f ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-100',
                  )}
                >
                  {f === 'pending' ? `Pending (${data.pending})` : `All (${data.total})`}
                </button>
              ))}
            </div>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-gray-400">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-gray-400 border rounded-lg p-6 text-center">
          {filter === 'pending'
            ? 'Nothing awaiting annotation — every scored record has feedback.'
            : 'No records with a judge profile yet. Evaluate some tasks first.'}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <QueueRow
              key={item.task_id}
              item={item}
              open={openTask === item.task_id}
              onToggle={() => setOpenTask((t) => (t === item.task_id ? null : item.task_id))}
              onSaved={() => {
                queryClient.invalidateQueries({ queryKey: ['calibration-queue'] })
                setOpenTask(null)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function QueueRow({
  item,
  open,
  onToggle,
  onSaved,
}: {
  item: CalibrationQueueItem
  open: boolean
  onToggle: () => void
  onSaved: () => void
}) {
  return (
    <div className="border rounded-lg bg-white">
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50">
        {open ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
        <span className="flex-1 truncate text-sm text-gray-800">{item.title || item.task_id}</span>
        {item.has_feedback && (
          <span className="flex items-center gap-0.5 text-xs text-green-600">
            <Check className="h-3 w-3" /> rated
          </span>
        )}
        {item.model_used && <span className="text-xs text-gray-400">{item.model_used}</span>}
        {item.weighted_score != null && (
          <span className="text-xs font-medium text-gray-600">judge {item.weighted_score.toFixed(1)}</span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 border-t pt-2">
          <AnnotationPanel taskId={item.task_id} onSaved={onSaved} />
        </div>
      )}
    </div>
  )
}

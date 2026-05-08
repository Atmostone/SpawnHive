import { useState } from 'react'
import { format } from 'date-fns'
import { Target, Lightbulb, MessageSquare, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ReasoningEvent {
  id: number
  event_type: string
  source: string
  data: Record<string, unknown>
  created_at: string
}

interface ReasoningTimelineProps {
  events: ReasoningEvent[]
}

type OrchestratorEventType = 'orchestrator_decision' | 'orchestrator_reasoning'

interface OrchestratorEvent extends ReasoningEvent {
  event_type: OrchestratorEventType
}

const REASONING_TYPES: OrchestratorEventType[] = [
  'orchestrator_decision',
  'orchestrator_reasoning',
]

function isOrchestratorEvent(ev: ReasoningEvent): ev is OrchestratorEvent {
  return (REASONING_TYPES as string[]).includes(ev.event_type)
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function summarize(ev: OrchestratorEvent): string {
  const d = ev.data || {}
  const decision = asString(d.decision)
  if (decision) return truncate(decision)
  const action = asString(d.action)
  if (action) {
    const tplName = asString(d.template_name)
    if (action === 'template_selected' && tplName) return `Selected template: ${tplName}`
    if (action === 'decomposed' && typeof d.subtask_count === 'number') {
      return `Decomposed into ${d.subtask_count} subtask${d.subtask_count === 1 ? '' : 's'}`
    }
    const reason = asString(d.reason)
    if (action === 'failed' && reason) return `Failed: ${reason}`
    if (action === 'processing_task') {
      const title = asString(d.title)
      return title ? `Processing: ${truncate(title, 80)}` : 'Processing task'
    }
    return action.replace(/_/g, ' ')
  }
  const reasoning = asString(d.reasoning)
  if (reasoning) return truncate(reasoning)
  return ev.event_type
}

function iconFor(ev: OrchestratorEvent) {
  if (ev.event_type === 'orchestrator_reasoning') {
    return MessageSquare
  }
  const action = asString(ev.data?.action)
  if (action === 'decomposed') return Lightbulb
  return Target
}

export default function ReasoningTimeline({ events }: ReasoningTimelineProps) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})

  const items = events
    .filter(isOrchestratorEvent)
    .slice()
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )

  if (items.length === 0) return null

  const toggle = (id: number) =>
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-500 mb-2">Reasoning</h3>
      <ol className="space-y-1.5 border-l border-gray-200 pl-3">
        {items.map(ev => {
          const Icon = iconFor(ev)
          const isOpen = !!expanded[ev.id]
          const isReasoning = ev.event_type === 'orchestrator_reasoning'
          return (
            <li key={ev.id} className="relative">
              <button
                type="button"
                onClick={() => toggle(ev.id)}
                className="w-full text-left flex items-start gap-2 group"
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                    isReasoning
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-purple-100 text-purple-700',
                  )}
                >
                  <Icon className="h-3 w-3" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5 text-xs">
                    <ChevronRight
                      className={cn(
                        'h-3 w-3 text-gray-400 transition-transform',
                        isOpen && 'rotate-90',
                      )}
                    />
                    <span className="text-gray-800 truncate">
                      {summarize(ev)}
                    </span>
                  </span>
                  <span className="block text-[10px] text-gray-400 ml-4">
                    {format(new Date(ev.created_at), 'HH:mm:ss')}
                  </span>
                </span>
              </button>
              <div
                className={cn(
                  'overflow-hidden transition-all ml-7',
                  isOpen ? 'max-h-96 mt-1' : 'max-h-0',
                )}
              >
                <pre className="text-[11px] font-mono bg-gray-50 border border-gray-200 rounded p-2 overflow-auto max-h-80 whitespace-pre-wrap break-words">
                  {JSON.stringify(ev.data ?? {}, null, 2)}
                </pre>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

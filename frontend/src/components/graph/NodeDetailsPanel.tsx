import { useMemo } from 'react'
import { X } from 'lucide-react'
import { format } from 'date-fns'
import type { AgentEvent } from '@/types'
import { colorForEventType, EDGE_COLORS } from './EventEdgeAnim'

export interface SelectedNode {
  type: 'orchestrator' | 'agent'
  id: string
}

export interface NodeDetailsPanelProps {
  selectedNode: SelectedNode | null
  events: AgentEvent[]
  cutoffTime: Date | null
  onClose: () => void
}

function withinCutoff(ev: AgentEvent, cutoffTime: Date | null): boolean {
  if (!cutoffTime) return true
  return new Date(ev.created_at).getTime() <= cutoffTime.getTime()
}

export default function NodeDetailsPanel({
  selectedNode,
  events,
  cutoffTime,
  onClose,
}: NodeDetailsPanelProps) {
  const filtered = useMemo(
    () => events.filter((e) => withinCutoff(e, cutoffTime)),
    [events, cutoffTime],
  )

  const content = useMemo(() => {
    if (!selectedNode) return null

    if (selectedNode.type === 'orchestrator') {
      const decisions = filtered.filter(
        (e) => e.source === 'orchestrator' || e.event_type === 'orchestrator_decision',
      ).length
      return (
        <div className="space-y-3 text-sm">
          <div>
            <div className="text-xs text-gray-500">Node</div>
            <div className="font-medium text-gray-900">Orchestrator</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Decisions / orchestrator events</div>
            <div className="font-mono text-base text-gray-900">{decisions}</div>
          </div>
        </div>
      )
    }

    // agent
    const cid = selectedNode.id
    const agentEvents = filtered.filter((e) => e.agent_container_id === cid)
    const latestWithTask = [...agentEvents].reverse().find((e) => !!e.task_id)
    const latestTpl = [...agentEvents]
      .reverse()
      .find((e) => typeof (e.data as Record<string, unknown>)?.template_name === 'string')
    const templateName = latestTpl
      ? String((latestTpl.data as Record<string, unknown>).template_name)
      : '—'

    let inputTokens = 0
    let outputTokens = 0
    for (const e of agentEvents) {
      const d = e.data as Record<string, unknown>
      const usage = (d?.token_usage ?? d?.usage) as
        | Record<string, unknown>
        | undefined
      if (usage) {
        const i = Number((usage as Record<string, unknown>).input ?? (usage as Record<string, unknown>).input_tokens ?? 0)
        const o = Number((usage as Record<string, unknown>).output ?? (usage as Record<string, unknown>).output_tokens ?? 0)
        if (Number.isFinite(i)) inputTokens += i
        if (Number.isFinite(o)) outputTokens += o
      }
    }

    const last20 = agentEvents.slice(0, 20)

    return (
      <div className="space-y-3 text-sm">
        <div>
          <div className="text-xs text-gray-500">Container</div>
          <div className="font-mono text-sm text-gray-900">{cid.slice(0, 12)}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Template</div>
          <div className="text-sm text-gray-900">{templateName}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Latest task</div>
          <div className="font-mono text-xs text-gray-900">
            {latestWithTask?.task_id ? latestWithTask.task_id.slice(0, 8) : '—'}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Token usage (sum)</div>
          <div className="text-sm text-gray-900">
            in <span className="font-mono">{inputTokens}</span> · out{' '}
            <span className="font-mono">{outputTokens}</span>
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs text-gray-500">Last events</div>
          <div className="max-h-72 space-y-1 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-2">
            {last20.length === 0 ? (
              <div className="text-xs text-gray-500">No events yet.</div>
            ) : (
              last20.map((ev) => {
                const colorKey = colorForEventType(ev.event_type)
                return (
                  <div key={ev.id} className="flex items-center gap-2 text-[11px]">
                    <span className="text-gray-400">
                      {format(new Date(ev.created_at), 'HH:mm:ss')}
                    </span>
                    <span
                      className="rounded px-1.5 py-0.5 font-medium text-white"
                      style={{ backgroundColor: EDGE_COLORS[colorKey] }}
                    >
                      {ev.event_type}
                    </span>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
    )
  }, [selectedNode, filtered])

  if (!selectedNode) return null

  return (
    <aside className="flex h-full w-[360px] flex-col border-l border-gray-200 bg-white">
      <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500">Details</div>
          <div className="text-sm font-medium text-gray-900">
            {selectedNode.type === 'orchestrator' ? 'Orchestrator' : 'Agent'}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-gray-500 hover:bg-gray-100"
          title="Close"
          aria-label="Close details panel"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">{content}</div>
    </aside>
  )
}

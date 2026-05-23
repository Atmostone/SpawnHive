import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Wifi, WifiOff, PanelRight } from 'lucide-react'
import { ReactFlowProvider } from 'reactflow'
import { eventsApi, buildWsUrl, templatesApi } from '@/api/client'
import type { AgentEvent } from '@/types'
import GraphCanvas, { type GraphLayout } from '@/components/graph/GraphCanvas'
import TimelineSlider from '@/components/graph/TimelineSlider'
import NodeDetailsPanel, {
  type SelectedNode,
} from '@/components/graph/NodeDetailsPanel'
import { EDGE_COLORS } from '@/components/graph/EventEdgeAnim'

const WINDOW_HOURS = 24
const PULSE_MS = 600

const LAYOUT_LABELS: Record<GraphLayout, string> = {
  force: 'Force',
  hierarchical: 'Hierarchical',
  circular: 'Circular',
}

const COLOR_LEGEND: { label: string; color: string }[] = [
  { label: 'message / status', color: EDGE_COLORS.blue },
  { label: 'progress / completed', color: EDGE_COLORS.green },
  { label: 'orchestrator', color: EDGE_COLORS.orange },
  { label: 'failed / killed', color: EDGE_COLORS.red },
  { label: 'other', color: EDGE_COLORS.gray },
]

function edgeIdFor(ev: AgentEvent): string | null {
  if (!ev.agent_container_id) return null
  if (ev.source === 'agent') return `${ev.agent_container_id}->orchestrator`
  return `orchestrator->${ev.agent_container_id}`
}

export default function CommunicationView() {
  const [layout, setLayout] = useState<GraphLayout>('hierarchical')
  const [selectedNode, setSelectedNode] = useState<SelectedNode | null>(null)
  const [panelOpen, setPanelOpen] = useState(true)
  const [wsConnected, setWsConnected] = useState(false)

  const [liveEvents, setLiveEvents] = useState<AgentEvent[]>([])

  const [minTime, setMinTime] = useState<Date>(() => new Date(Date.now() - WINDOW_HOURS * 3600 * 1000))
  const [maxTime, setMaxTime] = useState<Date>(() => new Date())
  const [cutoffTime, setCutoffTime] = useState<Date>(() => new Date())
  const [isLive, setIsLive] = useState(true)

  const [pulsingEdges, setPulsingEdges] = useState<Set<string>>(new Set())
  const pulseTimers = useRef<Map<string, number>>(new Map())

  const fromIso = useMemo(() => new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString(), [])
  const { data: initialEvents } = useQuery({
    queryKey: ['graph-events', fromIso],
    queryFn: () => eventsApi.list({ from_dt: fromIso, limit: 1000 }),
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (initialEvents) setLiveEvents(initialEvents as unknown as AgentEvent[])
  }, [initialEvents])

  const { data: templates } = useQuery({
    queryKey: ['templates'],
    queryFn: () => templatesApi.list(),
    staleTime: 5 * 60 * 1000,
  })

  const templateNameByContainer = useMemo(() => {
    const tplById = new Map<string, string>()
    for (const t of templates ?? []) tplById.set(t.id, t.name)

    const map = new Map<string, string>()
    for (const ev of liveEvents) {
      if (!ev.agent_container_id) continue
      if (map.has(ev.agent_container_id)) continue
      const d = ev.data as Record<string, unknown>
      const tn = d?.template_name
      const tid = d?.template_id
      if (typeof tn === 'string' && tn.length > 0) {
        map.set(ev.agent_container_id, tn)
      } else if (typeof tid === 'string' && tplById.has(tid)) {
        map.set(ev.agent_container_id, tplById.get(tid) ?? '')
      }
    }
    return map
  }, [liveEvents, templates])

  useEffect(() => {
    const t = window.setInterval(() => {
      setMaxTime(new Date())
      setMinTime(new Date(Date.now() - WINDOW_HOURS * 3600 * 1000))
    }, 30_000)
    return () => window.clearInterval(t)
  }, [])

  const wsRef = useRef<WebSocket | null>(null)
  const isLiveRef = useRef(isLive)
  useEffect(() => { isLiveRef.current = isLive }, [isLive])

  const connectWs = useCallback(() => {
    const ws = new WebSocket(buildWsUrl('/ws/events'))
    wsRef.current = ws
    ws.onopen = () => {
      setWsConnected(true)
      ws.send(JSON.stringify({}))
    }
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as Record<string, unknown> & { type?: string }
        if (data.type !== 'event') return
        const { type: _t, ...rest } = data
        void _t
        const ev = rest as unknown as AgentEvent

        setLiveEvents((prev) => {
          if (prev.some((p) => p.id === ev.id)) return prev
          return [ev, ...prev].slice(0, 5000)
        })

        const evTime = new Date(ev.created_at)
        if (isLiveRef.current) {
          setMaxTime((m) => (evTime > m ? evTime : m))
          setCutoffTime((c) => (evTime > c ? evTime : c))
        } else {
          setMaxTime((m) => (evTime > m ? evTime : m))
        }

        const eid = edgeIdFor(ev)
        if (eid) {
          setPulsingEdges((prev) => {
            const next = new Set(prev)
            next.add(eid)
            return next
          })
          const existing = pulseTimers.current.get(eid)
          if (existing != null) window.clearTimeout(existing)
          const timer = window.setTimeout(() => {
            setPulsingEdges((prev) => {
              const next = new Set(prev)
              next.delete(eid)
              return next
            })
            pulseTimers.current.delete(eid)
          }, PULSE_MS)
          pulseTimers.current.set(eid, timer)
        }
      } catch {
        // ignore malformed frames
      }
    }
    ws.onclose = () => {
      setWsConnected(false)
      window.setTimeout(connectWs, 2000)
    }
    ws.onerror = () => {
      try { ws.close() } catch { /* noop */ }
    }
    return ws
  }, [])

  useEffect(() => {
    const ws = connectWs()
    return () => {
      try { ws.close() } catch { /* noop */ }
      const timers = pulseTimers.current
      for (const id of timers.values()) window.clearTimeout(id)
      timers.clear()
    }
  }, [connectWs])

  useEffect(() => {
    setCutoffTime((c) => {
      if (c.getTime() < minTime.getTime()) return minTime
      if (c.getTime() > maxTime.getTime()) return maxTime
      return c
    })
  }, [minTime, maxTime])

  useEffect(() => {
    if (isLive) setCutoffTime(maxTime)
  }, [maxTime, isLive])

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNode(
      nodeId === 'orchestrator'
        ? { type: 'orchestrator', id: nodeId }
        : { type: 'agent', id: nodeId },
    )
    setPanelOpen(true)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-2">
        <div className="flex items-center gap-3">
          {wsConnected ? (
            <span title="Real-time connected"><Wifi className="h-4 w-4 text-green-500" /></span>
          ) : (
            <span title="Reconnecting..."><WifiOff className="h-4 w-4 text-gray-400" /></span>
          )}
          <span className="text-xs text-gray-500">Live agent communication (24h window)</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 text-[11px] text-gray-600">
            {COLOR_LEGEND.map((l) => (
              <span key={l.label} className="flex items-center gap-1">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: l.color }}
                />
                {l.label}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded border border-gray-200 p-0.5">
            {(Object.keys(LAYOUT_LABELS) as GraphLayout[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setLayout(k)}
                className={
                  'rounded px-2 py-1 text-xs ' +
                  (layout === k
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-600 hover:bg-gray-100')
                }
              >
                {LAYOUT_LABELS[k]}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPanelOpen((v) => !v)}
            className="flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            title="Toggle details panel"
          >
            <PanelRight className="h-3.5 w-3.5" />
            Details
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <ReactFlowProvider>
            <GraphCanvas
              events={liveEvents}
              cutoffTime={cutoffTime}
              layout={layout}
              onNodeClick={handleNodeClick}
              pulsingEdges={pulsingEdges}
              templateNameByContainer={templateNameByContainer}
            />
          </ReactFlowProvider>
        </div>
        {panelOpen && selectedNode && (
          <NodeDetailsPanel
            selectedNode={selectedNode}
            events={
              selectedNode.type === 'agent'
                ? liveEvents.filter((e) => e.agent_container_id === selectedNode.id)
                : liveEvents
            }
            cutoffTime={cutoffTime}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>

      <TimelineSlider
        minTime={minTime}
        maxTime={maxTime}
        value={cutoffTime}
        onChange={setCutoffTime}
        isLive={isLive}
        onLiveChange={setIsLive}
      />
    </div>
  )
}

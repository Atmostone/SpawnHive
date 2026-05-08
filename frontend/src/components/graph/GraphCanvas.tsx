import { useMemo, useEffect } from 'react'
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  useEdgesState,
} from 'reactflow'
import type { Node, Edge, NodeMouseHandler } from 'reactflow'
import dagre from 'dagre'
import 'reactflow/dist/style.css'
import type { AgentEvent } from '@/types'
import {
  EventEdgeAnim,
  EDGE_COLORS,
  colorForEventType,
  type EventEdgeData,
} from './EventEdgeAnim'

export type GraphLayout = 'force' | 'hierarchical' | 'circular'

export interface GraphCanvasProps {
  events: AgentEvent[]
  cutoffTime: Date | null
  layout: GraphLayout
  onNodeClick: (nodeId: string) => void
  /**
   * IDs of edges that just received a new event — used to trigger pulse animation.
   * The Graph page resets this set after the animation duration.
   */
  pulsingEdges: Set<string>
  /** Optional template-name lookup for nicer agent labels. */
  templateNameByContainer?: Map<string, string>
}

const ORCHESTRATOR_ID = 'orchestrator'

interface AgentInfo {
  containerId: string
  eventCount: number
  templateName?: string
}

interface EdgeAggregate {
  source: string
  target: string
  count: number
  latestType: string
}

/**
 * Aggregates events filtered by cutoffTime into:
 *  - the set of agent containers seen
 *  - per-direction edge stats (count + latest event type)
 */
function aggregate(events: AgentEvent[], cutoffTime: Date | null) {
  const cutoff = cutoffTime ? cutoffTime.getTime() : Number.POSITIVE_INFINITY
  const agents = new Map<string, AgentInfo>()
  const edges = new Map<string, EdgeAggregate>()

  for (const ev of events) {
    if (!ev.agent_container_id) continue
    const ts = new Date(ev.created_at).getTime()
    if (ts > cutoff) continue

    const cid = ev.agent_container_id
    const info = agents.get(cid) ?? { containerId: cid, eventCount: 0 }
    info.eventCount += 1
    // Best-effort template name extraction from event payloads.
    if (!info.templateName) {
      const tn = (ev.data as Record<string, unknown>)?.template_name
      if (typeof tn === 'string' && tn.length > 0) info.templateName = tn
    }
    agents.set(cid, info)

    let from: string
    let to: string
    if (ev.source === 'agent') {
      from = cid
      to = ORCHESTRATOR_ID
    } else {
      // 'orchestrator' / 'system' / 'user' → arrow points at the agent
      from = ORCHESTRATOR_ID
      to = cid
    }
    const key = `${from}->${to}`
    const agg = edges.get(key) ?? { source: from, target: to, count: 0, latestType: ev.event_type }
    agg.count += 1
    agg.latestType = ev.event_type // events come newest-first; we overwrite anyway with last seen
    edges.set(key, agg)
  }

  return { agents, edges }
}

function nodeSizeFor(eventCount: number, maxCount: number): number {
  const min = 40
  const max = 120
  if (maxCount <= 0) return min
  const ratio = Math.min(1, eventCount / maxCount)
  return Math.round(min + (max - min) * ratio)
}

/**
 * Lays out nodes with dagre (top → down).
 * Returns a map from node id to position.
 */
function dagreLayout(
  nodeIds: string[],
  edges: EdgeAggregate[],
  nodeSize: Map<string, number>,
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 100 })
  for (const id of nodeIds) {
    const s = nodeSize.get(id) ?? 80
    g.setNode(id, { width: s, height: s })
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target)
  }
  dagre.layout(g)
  const out = new Map<string, { x: number; y: number }>()
  for (const id of nodeIds) {
    const n = g.node(id)
    if (n) out.set(id, { x: n.x, y: n.y })
  }
  return out
}

/**
 * Lays out agents on a circle around the orchestrator (which sits at the center).
 */
function circularLayout(
  agentIds: string[],
  radius = 280,
  cx = 0,
  cy = 0,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  out.set(ORCHESTRATOR_ID, { x: cx, y: cy })
  const n = agentIds.length
  if (n === 0) return out
  for (let i = 0; i < n; i += 1) {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2
    out.set(agentIds[i], {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    })
  }
  return out
}

/**
 * "Force-like" radial layout — agents are scattered on rings around orchestrator,
 * the busier (higher event count) the closer to the center. No physics, just math.
 */
function forceLayout(
  agents: AgentInfo[],
  maxCount: number,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  out.set(ORCHESTRATOR_ID, { x: 0, y: 0 })
  const n = agents.length
  if (n === 0) return out
  for (let i = 0; i < n; i += 1) {
    const a = agents[i]
    const ratio = maxCount > 0 ? a.eventCount / maxCount : 0
    // Busier agents float closer (180px), idle ones further (380px).
    const radius = 380 - 200 * ratio
    const angle = (2 * Math.PI * i) / n + (i % 2 === 0 ? 0 : Math.PI / n)
    out.set(a.containerId, {
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
    })
  }
  return out
}

const edgeTypes = { eventEdge: EventEdgeAnim }

export default function GraphCanvas({
  events,
  cutoffTime,
  layout,
  onNodeClick,
  pulsingEdges,
  templateNameByContainer,
}: GraphCanvasProps) {
  const { nodes: derivedNodes, edges: derivedEdges } = useMemo(() => {
    const { agents, edges: edgeMap } = aggregate(events, cutoffTime)
    const agentList = Array.from(agents.values())
    const maxCount = agentList.reduce((m, a) => Math.max(m, a.eventCount), 0)

    const nodeSize = new Map<string, number>()
    nodeSize.set(ORCHESTRATOR_ID, 100)
    for (const a of agentList) {
      nodeSize.set(a.containerId, nodeSizeFor(a.eventCount, maxCount))
    }

    const allEdges = Array.from(edgeMap.values())
    const allIds = [ORCHESTRATOR_ID, ...agentList.map((a) => a.containerId)]

    let positions: Map<string, { x: number; y: number }>
    if (layout === 'hierarchical') {
      positions = dagreLayout(allIds, allEdges, nodeSize)
    } else if (layout === 'circular') {
      positions = circularLayout(agentList.map((a) => a.containerId))
    } else {
      positions = forceLayout(agentList, maxCount)
    }

    // Build reactflow nodes
    const nodes: Node[] = []
    const orchSize = nodeSize.get(ORCHESTRATOR_ID) ?? 100
    const orchPos = positions.get(ORCHESTRATOR_ID) ?? { x: 0, y: 0 }
    nodes.push({
      id: ORCHESTRATOR_ID,
      position: orchPos,
      data: { label: 'Orchestrator' },
      style: {
        width: orchSize,
        height: orchSize,
        background: 'linear-gradient(135deg,#a855f7,#7c3aed)',
        color: 'white',
        border: '2px solid #6d28d9',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 600,
        textAlign: 'center',
        padding: 4,
        boxShadow: '0 4px 12px rgba(124,58,237,0.35)',
      },
    })

    for (const a of agentList) {
      const size = nodeSize.get(a.containerId) ?? 60
      const pos = positions.get(a.containerId) ?? { x: 0, y: 0 }
      const tplName = templateNameByContainer?.get(a.containerId) ?? a.templateName
      const short = a.containerId.slice(0, 12)
      const label = tplName ? `${tplName}\n${short}` : short
      nodes.push({
        id: a.containerId,
        position: pos,
        data: { label, containerId: a.containerId, eventCount: a.eventCount },
        style: {
          width: size,
          height: size,
          background: '#fff',
          color: '#1f2937',
          border: '2px solid #3b82f6',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: Math.max(9, Math.min(11, size / 8)),
          fontWeight: 500,
          textAlign: 'center',
          whiteSpace: 'pre-line',
          padding: 4,
          boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
        },
      })
    }

    // Build reactflow edges
    const rfEdges: Edge<EventEdgeData>[] = allEdges.map((e) => {
      const id = `${e.source}->${e.target}`
      const colorKey = colorForEventType(e.latestType)
      const color = EDGE_COLORS[colorKey]
      return {
        id,
        source: e.source,
        target: e.target,
        type: 'eventEdge',
        data: { count: e.count, color, pulse: pulsingEdges.has(id) },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      }
    })

    return { nodes, edges: rfEdges }
  }, [events, cutoffTime, layout, pulsingEdges, templateNameByContainer])

  const [nodes, setNodes, onNodesChange] = useNodesState(derivedNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(derivedEdges)

  // Sync derived → state when inputs change
  useEffect(() => { setNodes(derivedNodes) }, [derivedNodes, setNodes])
  useEffect(() => { setEdges(derivedEdges) }, [derivedEdges, setEdges])

  const handleNodeClick: NodeMouseHandler = (_, node) => {
    onNodeClick(node.id)
  }

  if (nodes.length === 1) {
    // only orchestrator — show empty hint inside the canvas frame
    return (
      <div className="relative h-full w-full">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          edgeTypes={edgeTypes}
          fitView
          minZoom={0.2}
          maxZoom={2}
        >
          <Background gap={24} size={1} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-lg bg-white/90 px-4 py-2 text-sm text-gray-500 shadow-sm">
            No agent activity in the selected window.
          </div>
        </div>
      </div>
    )
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      edgeTypes={edgeTypes}
      fitView
      minZoom={0.2}
      maxZoom={2}
    >
      <Background gap={24} size={1} />
      <Controls />
      <MiniMap pannable zoomable />
    </ReactFlow>
  )
}

import { useEffect, useRef, useState } from 'react'
import { eventsApi, buildWsUrl } from '@/api/client'
import type { AgentEvent } from '@/types'

export interface AgentLiveData {
  currentStep: string | null
  recentOutput: string | null
  lastHealthAt: number | null
}

interface ProgressData {
  current_step?: unknown
  recent_output?: unknown
  output?: unknown
  step?: unknown
}

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (v == null) return null
  return String(v)
}

function extractProgress(ev: AgentEvent, prev: AgentLiveData): { step: string | null; output: string | null } {
  const d = ev.data as ProgressData
  const step = asString(d.current_step ?? d.step) ?? prev.currentStep
  const output = asString(d.recent_output ?? d.output) ?? prev.recentOutput
  return { step, output }
}

/**
 * Subscribes to per-agent WS narrow stream and seeds latest agent_progress
 * and agent_health events. Returns the latest current_step, recent_output,
 * and timestamp (ms) of the last health heartbeat.
 */
export function useAgentLiveData(containerId: string): AgentLiveData {
  const [data, setData] = useState<AgentLiveData>({
    currentStep: null,
    recentOutput: null,
    lastHealthAt: null,
  })
  const dataRef = useRef(data)
  dataRef.current = data

  // Initial load: latest agent_progress (limit=20) and agent_health (limit=1)
  useEffect(() => {
    let cancelled = false

    async function loadInitial() {
      const [progressEvents, healthEvents] = await Promise.all([
        eventsApi.list({
          agent_container_id: containerId,
          event_type: 'agent_progress',
          limit: 20,
        }),
        eventsApi.list({
          agent_container_id: containerId,
          event_type: 'agent_health',
          limit: 1,
        }),
      ])
      if (cancelled) return

      // events come back desc — take the freshest progress event
      let nextStep: string | null = null
      let nextOutput: string | null = null
      if (progressEvents.length > 0) {
        const latest = progressEvents[0]
        const d = latest.data as ProgressData
        nextStep = asString(d.current_step ?? d.step)
        nextOutput = asString(d.recent_output ?? d.output)
      }

      const lastHealthAt =
        healthEvents.length > 0 ? new Date(healthEvents[0].created_at).getTime() : null

      setData({ currentStep: nextStep, recentOutput: nextOutput, lastHealthAt })
    }

    loadInitial()
    return () => {
      cancelled = true
    }
  }, [containerId])

  // WebSocket: per-agent narrow stream
  useEffect(() => {
    let cancelled = false
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (cancelled) return
      ws = new WebSocket(buildWsUrl(`/ws/agents/${containerId}`))

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type !== 'event') return
          const { type: _t, ...evRaw } = msg
          const ev = evRaw as AgentEvent
          if (ev.event_type === 'agent_progress') {
            setData((prev) => {
              const { step, output } = extractProgress(ev, prev)
              return { ...prev, currentStep: step, recentOutput: output }
            })
          } else if (ev.event_type === 'agent_health') {
            const t = new Date(ev.created_at).getTime()
            setData((prev) => ({ ...prev, lastHealthAt: t }))
          }
        } catch {
          // ignore malformed frames
        }
      }

      ws.onclose = () => {
        if (cancelled) return
        reconnectTimer = setTimeout(connect, 2000)
      }
    }

    connect()
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (ws) ws.close()
    }
  }, [containerId])

  return data
}

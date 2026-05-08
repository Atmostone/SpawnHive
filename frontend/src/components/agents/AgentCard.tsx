import { useEffect, useState } from 'react'
import { Bot, Skull, Cpu } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import type { Agent } from '@/types'
import { currentRole } from '@/stores/auth'
import { useAgentLiveData } from '@/hooks/useAgentLiveData'
import SwitchModelModal from './SwitchModelModal'
import { cn } from '@/lib/utils'

const MAX_OUTPUT_CHARS = 500

type Health = 'healthy' | 'stale' | 'unhealthy' | 'dead'

const HEALTH_STYLES: Record<Health, { dot: string; label: string; pill: string }> = {
  healthy: { dot: 'bg-green-500', label: 'healthy', pill: 'bg-green-50 text-green-700' },
  stale: { dot: 'bg-yellow-500', label: 'stale', pill: 'bg-yellow-50 text-yellow-700' },
  unhealthy: { dot: 'bg-red-500', label: 'unhealthy', pill: 'bg-red-50 text-red-700' },
  dead: { dot: 'bg-gray-700', label: 'dead', pill: 'bg-gray-200 text-gray-700' },
}

function isDeadStatus(status: string): boolean {
  const s = status.toLowerCase()
  return s === 'dead' || s === 'exited' || s === 'killed' || s === 'stopped'
}

function deriveHealth(agentStatus: string, lastHealthAt: number | null, now: number): Health {
  if (isDeadStatus(agentStatus)) return 'dead'
  if (lastHealthAt == null) return 'unhealthy'
  const ageSec = (now - lastHealthAt) / 1000
  if (ageSec < 60) return 'healthy'
  if (ageSec < 180) return 'stale'
  return 'unhealthy'
}

interface Props {
  agent: Agent
  onKill: (id: string) => void
}

export default function AgentCard({ agent, onKill }: Props) {
  const { currentStep, recentOutput, lastHealthAt } = useAgentLiveData(agent.container_id)
  const [now, setNow] = useState(() => Date.now())
  const [showSwitch, setShowSwitch] = useState(false)

  // Re-evaluate health every 10s so the badge ticks from healthy → stale → unhealthy
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(id)
  }, [])

  const health = deriveHealth(agent.status, lastHealthAt, now)
  const healthStyle = HEALTH_STYLES[health]

  const role = currentRole()
  const canSwitchModel = role === 'owner' || role === 'admin'

  const truncatedOutput = recentOutput
    ? recentOutput.length > MAX_OUTPUT_CHARS
      ? recentOutput.slice(-MAX_OUTPUT_CHARS)
      : recentOutput
    : null

  return (
    <div className="bg-white rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="p-2 rounded-lg bg-blue-50 shrink-0">
            <Bot className="h-5 w-5 text-blue-600" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm truncate">{agent.name}</p>
            <p className="text-xs text-gray-500 truncate">{agent.template_name}</p>
            <p className="text-xs text-gray-400 truncate">
              Task: {agent.task_id?.slice(0, 8)}...
              {agent.created && ` | ${formatDistanceToNow(new Date(agent.created))} ago`}
            </p>
            {currentStep && (
              <p className="text-xs text-gray-700 mt-1 truncate" title={currentStep}>
                <span className="text-gray-400">step:</span> {currentStep}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={cn(
              'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full',
              healthStyle.pill,
            )}
            title={
              lastHealthAt
                ? `Last health: ${Math.round((now - lastHealthAt) / 1000)}s ago`
                : 'No health heartbeat yet'
            }
          >
            <span className={cn('inline-block w-2 h-2 rounded-full', healthStyle.dot)} />
            {healthStyle.label}
          </span>
          <span className="text-xs px-2 py-1 rounded-full bg-green-100 text-green-700">
            {agent.status}
          </span>
          {canSwitchModel && (
            <button
              type="button"
              onClick={() => setShowSwitch(true)}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
              title="Switch model"
            >
              <Cpu className="h-3 w-3" />
              Switch Model
            </button>
          )}
          <button
            onClick={() => onKill(agent.container_id)}
            className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600 transition-colors"
            title="Kill agent"
          >
            <Skull className="h-4 w-4" />
          </button>
        </div>
      </div>

      {truncatedOutput && (
        <pre className="mt-3 text-xs font-mono bg-gray-900 text-gray-100 rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words leading-5">
          {truncatedOutput}
        </pre>
      )}

      {showSwitch && (
        <SwitchModelModal
          containerId={agent.container_id}
          agentName={agent.name}
          onClose={() => setShowSwitch(false)}
        />
      )}
    </div>
  )
}

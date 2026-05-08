import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { tasksApi, agentsApi } from '@/api/client'
import { Activity, Bot, CheckCircle, Clock, Skull, Zap } from 'lucide-react'
import type { Agent } from '@/types'
import { formatDistanceToNow } from 'date-fns'

function StatCard({ label, value, icon: Icon, color }: { label: string; value: number | string; icon: React.ElementType; color: string }) {
  return (
    <div className="bg-white rounded-lg border p-4 flex items-center gap-4">
      <div className={`p-3 rounded-lg ${color}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-sm text-gray-500">{label}</p>
        <p className="text-2xl font-bold">{value}</p>
      </div>
    </div>
  )
}

function AgentCard({ agent, onKill }: { agent: Agent; onKill: (id: string) => void }) {
  return (
    <div className="bg-white rounded-lg border p-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-blue-50">
          <Bot className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <p className="font-medium text-sm">{agent.name}</p>
          <p className="text-xs text-gray-500">{agent.template_name}</p>
          <p className="text-xs text-gray-400">
            Task: {agent.task_id?.slice(0, 8)}...
            {agent.created && ` | ${formatDistanceToNow(new Date(agent.created))} ago`}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs px-2 py-1 rounded-full bg-green-100 text-green-700">
          {agent.status}
        </span>
        <button
          onClick={() => onKill(agent.container_id)}
          className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600 transition-colors"
          title="Kill agent"
        >
          <Skull className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

export default function Dashboard() {
  const queryClient = useQueryClient()

  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => tasksApi.list(),
    refetchInterval: 5000,
  })

  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
    refetchInterval: 5000,
  })

  const killMutation = useMutation({
    mutationFn: (id: string) => agentsApi.kill(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  const inProgress = tasks.filter(t => t.status === 'in_progress').length
  const awaitingApproval = tasks.filter(t => t.status === 'awaiting_approval').length
  const done = tasks.filter(t => t.status === 'done').length
  const totalTokens = tasks.reduce((acc, t) => {
    const usage = t.token_usage || {}
    return acc + (usage.input_tokens || 0) + (usage.output_tokens || 0)
  }, 0)

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="In Progress" value={inProgress} icon={Clock} color="bg-blue-50 text-blue-600" />
        <StatCard label="Awaiting Approval" value={awaitingApproval} icon={CheckCircle} color="bg-yellow-50 text-yellow-600" />
        <StatCard label="Active Agents" value={agents.length} icon={Bot} color="bg-green-50 text-green-600" />
        <StatCard label="Total Tokens" value={totalTokens.toLocaleString()} icon={Zap} color="bg-purple-50 text-purple-600" />
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Active Agents ({agents.length})
          </h2>
        </div>

        {agents.length === 0 ? (
          <div className="bg-white rounded-lg border p-8 text-center text-gray-500">
            <Bot className="h-12 w-12 mx-auto mb-3 text-gray-300" />
            <p>No active agents</p>
            <p className="text-sm mt-1">Create a task and set it to Ready to spawn an agent</p>
          </div>
        ) : (
          <div className="space-y-2">
            {agents.map(agent => (
              <AgentCard
                key={agent.container_id}
                agent={agent}
                onKill={(id) => killMutation.mutate(id)}
              />
            ))}
          </div>
        )}
      </div>

      {done > 0 && (
        <div className="text-sm text-gray-400">
          {done} task{done !== 1 ? 's' : ''} completed
        </div>
      )}
    </div>
  )
}

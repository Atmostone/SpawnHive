export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'decomposing'
  | 'in_progress'
  | 'review'
  | 'awaiting_approval'
  | 'done'
  | 'failed'

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'

export interface Task {
  id: string
  parent_id?: string | null
  title: string
  description?: string | null
  status: TaskStatus
  priority: TaskPriority
  template_id?: string | null
  agent_container_id?: string | null
  result_summary?: string | null
  result_files: string[]
  token_usage: Record<string, number>
  retry_count: number
  max_retries: number
  user_feedback?: string | null
  orchestrator_feedback?: string | null
  model_used?: string | null
  cost_usd?: number | null
  depends_on?: string[] | null
  created_at: string
  updated_at: string
  started_at?: string | null
  completed_at?: string | null
  subtasks?: Task[]
}

export interface MCPServer {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface Template {
  id: string
  name: string
  description: string
  soul_md: string
  model: string | null
  provider_url?: string | null
  provider_api_key?: string | null
  tools: string[]
  mcp_servers: MCPServer[]
  max_ram: string
  max_cpu: number
  timeout_minutes: number
  tags: string[]
  created_at: string
  updated_at: string
}

export interface Agent {
  container_id: string
  name: string
  status: string
  task_id: string
  template_id: string
  template_name: string
  created: string
}

export interface AgentEvent {
  id: number
  task_id?: string | null
  agent_container_id?: string | null
  event_type: string
  source: 'orchestrator' | 'agent' | 'user' | 'system'
  data: Record<string, unknown>
  created_at: string
}

export interface HealthStatus {
  status: string
  version: string
  services: Record<string, string>
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  decomposing: 'Decomposing',
  in_progress: 'In Progress',
  review: 'Review',
  awaiting_approval: 'Awaiting Approval',
  done: 'Done',
  failed: 'Failed',
}

export const PRIORITY_COLORS: Record<TaskPriority, string> = {
  low: 'bg-gray-100 text-gray-700',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-orange-100 text-orange-700',
  urgent: 'bg-red-100 text-red-700',
}

export const SOURCE_COLORS: Record<string, string> = {
  orchestrator: 'bg-purple-100 text-purple-700',
  agent: 'bg-blue-100 text-blue-700',
  user: 'bg-green-100 text-green-700',
  system: 'bg-gray-100 text-gray-700',
}

export const KANBAN_COLUMNS: TaskStatus[] = [
  'backlog',
  'ready',
  'in_progress',
  'review',
  'awaiting_approval',
  'done',
  'failed',
]

export interface MemoryEntity {
  id: string
  type: string
  name: string
  attributes: Record<string, unknown>
  created_by: string
  created_at: string
  updated_at: string
}

export interface MemoryRelation {
  id: string
  from_id: string
  to_id: string
  relation_type: string
  attributes: Record<string, unknown>
  created_at: string
}

export interface MemoryEntityDetail extends MemoryEntity {
  relations: MemoryRelation[]
}

import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { Task, TaskStatus } from '@/types'
import { TASK_STATUS_LABELS } from '@/types'
import { cn } from '@/lib/utils'
import TaskCard from './TaskCard'

const STATUS_HEADER_COLORS: Record<string, string> = {
  backlog: 'border-t-gray-400',
  ready: 'border-t-blue-400',
  decomposing: 'border-t-indigo-400',
  in_progress: 'border-t-yellow-400',
  review: 'border-t-orange-400',
  awaiting_approval: 'border-t-purple-400',
  done: 'border-t-green-400',
  failed: 'border-t-red-400',
}

interface KanbanColumnProps {
  status: TaskStatus
  tasks: Task[]
  onTaskClick: (task: Task) => void
}

export default function KanbanColumn({ status, tasks, onTaskClick }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: status })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex flex-col min-w-[260px] w-[260px] bg-gray-100 rounded-lg border-t-4',
        STATUS_HEADER_COLORS[status] || 'border-t-gray-300',
        isOver && 'bg-blue-50',
      )}
    >
      <div className="p-3 pb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">
          {TASK_STATUS_LABELS[status]}
        </h3>
        <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">
          {tasks.length}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[100px]">
        <SortableContext items={tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map(task => (
            <TaskCard key={task.id} task={task} onClick={onTaskClick} />
          ))}
        </SortableContext>
      </div>
    </div>
  )
}

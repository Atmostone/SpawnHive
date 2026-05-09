import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { tasksApi } from '@/api/client'
import type { Task } from '@/types'

interface Props {
  value: string | null
  onChange: (taskId: string | null) => void
}

export default function TaskSelector({ value, onChange }: Props) {
  const { data: tasks } = useQuery({
    queryKey: ['tasks-all'],
    queryFn: () => tasksApi.list(),
    staleTime: 30_000,
  })

  const parents = useMemo(() => {
    if (!tasks) return []
    const subtaskCount = new Map<string, number>()
    for (const t of tasks) {
      if (t.parent_id) {
        subtaskCount.set(t.parent_id, (subtaskCount.get(t.parent_id) ?? 0) + 1)
      }
    }
    return tasks
      .filter((t) => !t.parent_id && (subtaskCount.get(t.id) ?? 0) >= 1)
      .map((t) => ({ ...t, subtask_count: subtaskCount.get(t.id) ?? 0 }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
  }, [tasks])

  // If no value yet, default to first parent.
  useEffect(() => {
    if (!value && parents.length > 0) onChange(parents[0].id)
  }, [parents, value, onChange])

  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none"
    >
      {parents.length === 0 && <option value="">No decomposed tasks yet</option>}
      {parents.map((t) => (
        <option key={t.id} value={t.id}>
          {t.title} · {t.subtask_count} subtasks · {t.status}
        </option>
      ))}
    </select>
  )
}

export type { Task }

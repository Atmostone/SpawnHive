import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { GitBranch, RefreshCw } from 'lucide-react'
import { tasksApi } from '@/api/client'
import TaskSelector from './TaskSelector'
import DecompositionTree from './DecompositionTree'
import DecompositionGantt from './DecompositionGantt'

const URL_PARAM = 'task'

function readInitialTaskId(): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(URL_PARAM)
}

function writeUrlTaskId(id: string | null) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (id) url.searchParams.set(URL_PARAM, id)
  else url.searchParams.delete(URL_PARAM)
  window.history.replaceState({}, '', url)
}

export default function DecompositionView() {
  const [taskId, setTaskId] = useState<string | null>(readInitialTaskId)

  useEffect(() => writeUrlTaskId(taskId), [taskId])

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['decomposition', taskId],
    queryFn: () => tasksApi.getDecomposition(taskId as string),
    enabled: !!taskId,
    staleTime: 5_000,
  })

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-2">
        <div className="flex items-center gap-3">
          <GitBranch className="h-4 w-4 text-blue-600" />
          <span className="text-sm font-medium text-gray-700">Parent task:</span>
          <TaskSelector value={taskId} onChange={setTaskId} />
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={!taskId || isFetching}
          className="flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={'h-3.5 w-3.5 ' + (isFetching ? 'animate-spin' : '')} />
          Refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-gray-50 p-6">
        {!taskId && (
          <p className="text-sm text-gray-500">
            Select a decomposed parent task above to inspect its structure and per-attempt timeline.
          </p>
        )}
        {taskId && isLoading && (
          <p className="text-sm text-gray-500">Loading…</p>
        )}
        {taskId && data && data.subtasks.length === 0 && (
          <div className="rounded border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800">
            <strong>{data.parent.title}</strong> wasn't decomposed — orchestrator handled it as a single task.
            Pick another parent that has subtasks to see the tree.
          </div>
        )}
        {taskId && data && data.subtasks.length > 0 && (
          <div className="space-y-4">
            <DecompositionTree data={data} />
            <DecompositionGantt data={data} />
          </div>
        )}
      </div>
    </div>
  )
}

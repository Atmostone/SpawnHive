import { useEffect, useState } from 'react'
import { Network, GitBranch } from 'lucide-react'
import CommunicationView from '@/components/graph/CommunicationView'
import DecompositionView from '@/components/graph/DecompositionView'

type Tab = 'decomposition' | 'communication'

const STORAGE_KEY = 'graph.tab'

function readInitialTab(): Tab {
  if (typeof window === 'undefined') return 'decomposition'
  const v = window.localStorage.getItem(STORAGE_KEY)
  return v === 'communication' ? 'communication' : 'decomposition'
}

export default function Graph() {
  const [tab, setTab] = useState<Tab>(readInitialTab)

  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, tab)
  }, [tab])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-gray-200 bg-white px-6 pt-3">
        <button
          type="button"
          onClick={() => setTab('decomposition')}
          className={
            'flex items-center gap-2 border-b-2 px-3 pb-2 text-sm font-medium ' +
            (tab === 'decomposition'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700')
          }
        >
          <GitBranch className="h-4 w-4" />
          Decomposition
        </button>
        <button
          type="button"
          onClick={() => setTab('communication')}
          className={
            'flex items-center gap-2 border-b-2 px-3 pb-2 text-sm font-medium ' +
            (tab === 'communication'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700')
          }
        >
          <Network className="h-4 w-4" />
          Communication
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'decomposition' ? <DecompositionView /> : <CommunicationView />}
      </div>
    </div>
  )
}

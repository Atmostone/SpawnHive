import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { FileUp, Trash2, Search, Save, BookOpen, Brain, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { knowledgeApi, type KnowledgeDocument, type KnowledgeSearchResult } from '@/api/client'

type Tab = 'rules' | 'memory' | 'documents' | 'search'

export default function KnowledgeBase() {
  const [tab, setTab] = useState<Tab>('rules')

  const tabs: { key: Tab; label: string; icon: React.ElementType }[] = [
    { key: 'rules', label: 'Rules', icon: BookOpen },
    { key: 'memory', label: 'Memory', icon: Brain },
    { key: 'documents', label: 'Documents', icon: FileText },
    { key: 'search', label: 'Search', icon: Search },
  ]

  return (
    <div className="p-6 h-full flex flex-col">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">Knowledge Base</h1>

      <div className="flex gap-1 mb-4 border-b">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700',
            )}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'rules' && <EditorTab endpoint="rules" label="rules.md" />}
        {tab === 'memory' && <EditorTab endpoint="memory" label="memory.md" />}
        {tab === 'documents' && <DocumentsTab />}
        {tab === 'search' && <SearchTab />}
      </div>
    </div>
  )
}

function EditorTab({ endpoint, label }: { endpoint: 'rules' | 'memory'; label: string }) {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: ['knowledge', endpoint],
    queryFn: () => endpoint === 'rules' ? knowledgeApi.getRules() : knowledgeApi.getMemory(),
  })

  const [content, setContent] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const displayContent = content ?? data?.content ?? ''

  const saveMutation = useMutation({
    mutationFn: (c: string) => endpoint === 'rules' ? knowledgeApi.putRules(c) : knowledgeApi.putMemory(c),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge', endpoint] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm text-gray-500">{label} — shared with all agents</p>
        <button
          onClick={() => saveMutation.mutate(displayContent)}
          disabled={saveMutation.isPending}
          className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          <Save className="h-4 w-4" /> {saved ? 'Saved!' : 'Save'}
        </button>
      </div>
      <textarea
        value={displayContent}
        onChange={e => { setContent(e.target.value); setSaved(false) }}
        className="flex-1 w-full p-4 border rounded-lg font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
        placeholder={`# ${label}\n\nWrite your content here...`}
      />
    </div>
  )
}

function DocumentsTab() {
  const queryClient = useQueryClient()
  const { data: docs = [] } = useQuery<KnowledgeDocument[]>({
    queryKey: ['knowledge', 'documents'],
    queryFn: () => knowledgeApi.listDocuments(),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => knowledgeApi.deleteDocument(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['knowledge', 'documents'] }),
  })

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    await knowledgeApi.uploadDocument(file)
    queryClient.invalidateQueries({ queryKey: ['knowledge', 'documents'] })
    e.target.value = ''
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">Upload documents for RAG (.md, .txt, .pdf, .docx)</p>
        <label className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm cursor-pointer hover:bg-blue-700">
          <FileUp className="h-4 w-4" /> Upload
          <input type="file" className="hidden" onChange={handleUpload} accept=".md,.txt,.pdf,.docx" />
        </label>
      </div>

      {docs.length === 0 ? (
        <div className="bg-white rounded-lg border p-8 text-center text-gray-500">
          <FileText className="h-12 w-12 mx-auto mb-3 text-gray-300" />
          <p>No documents uploaded</p>
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map((d) => (
            <div key={d.id} className="bg-white rounded-lg border p-3 flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">{d.filename}</p>
                <p className="text-xs text-gray-400">{d.chunk_count} chunks</p>
              </div>
              <button
                onClick={() => deleteMutation.mutate(d.id)}
                className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-500"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SearchTab() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<KnowledgeSearchResult[]>([])
  const [searching, setSearching] = useState(false)

  async function handleSearch() {
    if (!query.trim()) return
    setSearching(true)
    try {
      const data = await knowledgeApi.search(query)
      setResults(data.results || [])
    } finally {
      setSearching(false)
    }
  }

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="Search knowledge base..."
          className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={handleSearch}
          disabled={searching}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          <Search className="h-4 w-4" />
        </button>
      </div>

      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((r, i) => (
            <div key={i} className="bg-white rounded-lg border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-gray-500">{r.filename}</span>
                <span className="text-xs text-gray-400">Score: {r.score.toFixed(3)}</span>
              </div>
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{r.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

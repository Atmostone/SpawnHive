import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import ReactFlow, { Background, Controls, Edge, MarkerType, Node } from 'reactflow'
import 'reactflow/dist/style.css'
import { Plus, Trash2, RefreshCw, Search } from 'lucide-react'
import { memoryApi } from '@/api/client'
import type { MemoryEntity } from '@/types'

type View = 'table' | 'graph'

export default function Memory() {
  const qc = useQueryClient()
  const [view, setView] = useState<View>('table')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const { data: entities = [] } = useQuery({
    queryKey: ['memory', 'entities', { search, typeFilter }],
    queryFn: () =>
      memoryApi.listEntities({
        search: search || undefined,
        type: typeFilter || undefined,
        limit: 500,
      }),
  })

  const { data: relations = [] } = useQuery({
    queryKey: ['memory', 'relations'],
    queryFn: () => memoryApi.listRelations({ limit: 1000 }),
  })

  const { data: detail } = useQuery({
    queryKey: ['memory', 'entity', selectedId],
    queryFn: () => memoryApi.getEntity(selectedId!),
    enabled: !!selectedId,
  })

  const deleteEntity = useMutation({
    mutationFn: (id: string) => memoryApi.deleteEntity(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memory'] })
      setSelectedId(null)
    },
  })

  const types = useMemo(
    () => Array.from(new Set(entities.map((e) => e.type))).sort(),
    [entities]
  )

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Memory</h1>
        <div className="flex gap-2">
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ['memory'] })}
            className="px-3 py-1.5 rounded-md border bg-white text-sm flex items-center gap-1.5 hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm flex items-center gap-1.5 hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            New entity
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or type..."
            className="w-full pl-9 pr-3 py-2 border rounded-md text-sm"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-3 py-2 border rounded-md text-sm bg-white"
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <div className="flex border rounded-md overflow-hidden bg-white">
          <button
            onClick={() => setView('table')}
            className={
              view === 'table'
                ? 'px-3 py-2 bg-gray-900 text-white text-sm'
                : 'px-3 py-2 text-sm hover:bg-gray-50'
            }
          >
            Table
          </button>
          <button
            onClick={() => setView('graph')}
            className={
              view === 'graph'
                ? 'px-3 py-2 bg-gray-900 text-white text-sm'
                : 'px-3 py-2 text-sm hover:bg-gray-50'
            }
          >
            Graph
          </button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-8 bg-white rounded-lg border overflow-hidden">
          {view === 'table' ? (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-3 py-2">Type</th>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Attributes</th>
                  <th className="text-left px-3 py-2">Source</th>
                  <th className="text-left px-3 py-2">Updated</th>
                </tr>
              </thead>
              <tbody>
                {entities.map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => setSelectedId(e.id)}
                    className={
                      selectedId === e.id
                        ? 'bg-blue-50 cursor-pointer'
                        : 'hover:bg-gray-50 cursor-pointer'
                    }
                  >
                    <td className="px-3 py-2">
                      <span className="inline-block bg-gray-100 px-2 py-0.5 rounded text-xs">
                        {e.type}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-medium">{e.name}</td>
                    <td className="px-3 py-2 text-gray-600 text-xs truncate max-w-xs">
                      {Object.entries(e.attributes || {})
                        .map(([k, v]) => `${k}=${v}`)
                        .join(', ')}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">{e.created_by}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">
                      {new Date(e.updated_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {entities.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-gray-500">
                      No entities yet. Memory is populated automatically when{' '}
                      <code className="bg-gray-100 px-1 rounded">memory_mode</code> is{' '}
                      <code>structured</code>.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <MemoryGraph
              entities={entities}
              relations={relations}
              onSelect={setSelectedId}
              selectedId={selectedId}
            />
          )}
        </div>

        <aside className="col-span-4 bg-white rounded-lg border p-4">
          {detail ? (
            <div>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <span className="text-xs bg-gray-100 px-2 py-0.5 rounded">{detail.type}</span>
                  <h2 className="text-lg font-semibold mt-1">{detail.name}</h2>
                </div>
                <button
                  onClick={() => {
                    if (confirm(`Delete entity "${detail.name}"?`))
                      deleteEntity.mutate(detail.id)
                  }}
                  className="text-red-600 hover:bg-red-50 p-1 rounded"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="text-xs text-gray-500 mb-3">
                Created by {detail.created_by} ·{' '}
                {new Date(detail.created_at).toLocaleString()}
              </div>
              <h3 className="text-sm font-semibold text-gray-700 mb-1">Attributes</h3>
              <div className="bg-gray-50 rounded p-2 text-sm mb-4">
                {Object.entries(detail.attributes || {}).length === 0 ? (
                  <span className="text-gray-400">empty</span>
                ) : (
                  Object.entries(detail.attributes).map(([k, v]) => (
                    <div key={k} className="flex">
                      <span className="text-gray-500 mr-2">{k}:</span>
                      <span>{String(v)}</span>
                    </div>
                  ))
                )}
              </div>
              <h3 className="text-sm font-semibold text-gray-700 mb-1">Relations</h3>
              <ul className="text-sm space-y-1">
                {detail.relations.length === 0 && (
                  <li className="text-gray-400">no relations</li>
                )}
                {detail.relations.map((r) => (
                  <li key={r.id} className="bg-gray-50 px-2 py-1 rounded text-xs">
                    {r.from_id === detail.id ? '→' : '←'} <b>{r.relation_type}</b>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="text-gray-400 text-sm">Select an entity to inspect.</div>
          )}
        </aside>
      </div>

      {showCreate && <CreateEntityModal onClose={() => setShowCreate(false)} />}
    </div>
  )
}

function MemoryGraph({
  entities,
  relations,
  onSelect,
  selectedId,
}: {
  entities: MemoryEntity[]
  relations: { id: string; from_id: string; to_id: string; relation_type: string }[]
  onSelect: (id: string) => void
  selectedId: string | null
}) {
  const nodes: Node[] = useMemo(() => {
    const cols = Math.ceil(Math.sqrt(Math.max(entities.length, 1)))
    return entities.slice(0, 500).map((e, i) => ({
      id: e.id,
      data: { label: `${e.type}\n${e.name}` },
      position: { x: (i % cols) * 220, y: Math.floor(i / cols) * 120 },
      style: {
        border: e.id === selectedId ? '2px solid #2563eb' : '1px solid #d1d5db',
        background: '#fff',
        padding: 8,
        borderRadius: 8,
        fontSize: 11,
        whiteSpace: 'pre-line',
      },
    }))
  }, [entities, selectedId])

  const ids = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes])
  const edges: Edge[] = useMemo(
    () =>
      relations
        .filter((r) => ids.has(r.from_id) && ids.has(r.to_id))
        .map((r) => ({
          id: r.id,
          source: r.from_id,
          target: r.to_id,
          label: r.relation_type,
          markerEnd: { type: MarkerType.ArrowClosed },
        })),
    [relations, ids]
  )

  return (
    <div style={{ width: '100%', height: 600 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={(_, n) => onSelect(n.id)}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}

function CreateEntityModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [type, setType] = useState('person')
  const [name, setName] = useState('')
  const [attrs, setAttrs] = useState('')
  const create = useMutation({
    mutationFn: () => {
      let attributes: Record<string, unknown> = {}
      try {
        if (attrs.trim()) attributes = JSON.parse(attrs)
      } catch {}
      return memoryApi.createEntity({ type, name, attributes })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memory'] })
      onClose()
    },
  })
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg p-6 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-4">New memory entity</h2>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-600">Type</label>
            <input
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full border rounded-md px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border rounded-md px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Attributes (JSON)</label>
            <textarea
              value={attrs}
              onChange={(e) => setAttrs(e.target.value)}
              rows={4}
              placeholder='{"role":"lead developer"}'
              className="w-full border rounded-md px-2 py-1.5 text-sm font-mono"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            disabled={!name.trim() || !type.trim()}
            onClick={() => create.mutate()}
            className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white disabled:bg-gray-300"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  )
}

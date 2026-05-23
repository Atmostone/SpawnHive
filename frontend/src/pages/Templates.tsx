import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { providersApi, templatesApi } from '@/api/client'
import type { Template } from '@/types'
import { Plus, Edit2, Trash2, Copy, X, Boxes, ServerIcon, AlertTriangle } from 'lucide-react'
import { ModelSelect } from '@/components/settings/SystemModelsSection'

interface MCPServerForm {
  name: string
  command: string
  args: string  // newline/CSV
  env: string   // KEY=VAL per line
}

function mcpToForm(s: { name: string; command: string; args: string[]; env?: Record<string, string> }): MCPServerForm {
  return {
    name: s.name,
    command: s.command,
    args: (s.args || []).join(' '),
    env: Object.entries(s.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'),
  }
}

function formToMcp(f: MCPServerForm) {
  const args = f.args.trim() ? f.args.trim().split(/\s+/) : []
  const env: Record<string, string> = {}
  for (const line of f.env.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return { name: f.name.trim(), command: f.command.trim(), args, env }
}

function TemplateForm({ template, onClose }: { template?: Template; onClose: () => void }) {
  const queryClient = useQueryClient()
  const isEdit = !!template

  const [form, setForm] = useState({
    name: template?.name || '',
    description: template?.description || '',
    soul_md: template?.soul_md || '',
    model_id: template?.model_id ?? null as string | null,
    tools: template?.tools || [],
    max_ram: template?.max_ram || '2g',
    max_cpu: template?.max_cpu || 100000,
    timeout_minutes: template?.timeout_minutes || 60,
    tags: template?.tags || [],
    mcp_servers: template?.mcp_servers || [],
  })

  const [toolsInput, setToolsInput] = useState(form.tools.join(', '))
  const [tagsInput, setTagsInput] = useState(form.tags.join(', '))
  const [mcpForms, setMcpForms] = useState<MCPServerForm[]>(
    (template?.mcp_servers || []).map(mcpToForm),
  )

  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: providersApi.list,
  })

  const createMutation = useMutation({
    mutationFn: () => templatesApi.create(form as Parameters<typeof templatesApi.create>[0]),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['templates'] }); onClose() },
  })

  const updateMutation = useMutation({
    mutationFn: () => templatesApi.update(template!.id, form),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['templates'] }); onClose() },
  })

  function handleSubmit() {
    const data = {
      ...form,
      tools: toolsInput.split(',').map(s => s.trim()).filter(Boolean),
      tags: tagsInput.split(',').map(s => s.trim()).filter(Boolean),
      mcp_servers: mcpForms
        .map(formToMcp)
        .filter(s => s.name && s.command),
    }
    Object.assign(form, data)
    if (isEdit) {
      updateMutation.mutate()
    } else {
      createMutation.mutate()
    }
  }

  const set = (field: string, value: unknown) => setForm(prev => ({ ...prev, [field]: value }))

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{isEdit ? 'Edit Template' : 'New Template'}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100"><X className="h-5 w-5" /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input value={form.name} onChange={e => set('name', e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="e.g. Coder" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description (for orchestrator)</label>
            <textarea value={form.description} onChange={e => set('description', e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm h-16 resize-none" placeholder="When to use this template..." />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">SOUL.md (agent personality)</label>
            <textarea value={form.soul_md} onChange={e => set('soul_md', e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm h-32 resize-y font-mono" placeholder="You are an expert..." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
              <ModelSelect
                providers={providers}
                value={form.model_id}
                onChange={(v) => set('model_id', v)}
                placeholder="— Pick a model —"
              />
              {!form.model_id && (
                <p className="text-xs text-orange-600 mt-1">
                  Without a model, the agent cannot be spawned.
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tools (comma-separated)</label>
              <input value={toolsInput} onChange={e => setToolsInput(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="bash, file_write, file_read" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Max RAM</label>
              <input value={form.max_ram} onChange={e => set('max_ram', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Max CPU (%)</label>
              <input type="number" value={form.max_cpu / 1000} onChange={e => set('max_cpu', Number(e.target.value) * 1000)}
                className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Timeout (min)</label>
              <input type="number" value={form.timeout_minutes} onChange={e => set('timeout_minutes', Number(e.target.value))}
                className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tags (comma-separated)</label>
            <input value={tagsInput} onChange={e => setTagsInput(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="coding, python" />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700 flex items-center gap-1">
                <ServerIcon className="h-4 w-4" /> MCP Servers
              </label>
              <button type="button"
                onClick={() => setMcpForms(prev => [...prev, { name: '', command: '', args: '', env: '' }])}
                className="text-xs px-2 py-1 border rounded hover:bg-gray-50">
                + Add server
              </button>
            </div>
            {mcpForms.length === 0 && (
              <p className="text-xs text-gray-400 mb-2">No MCP servers configured. Agent uses only built-in tools.</p>
            )}
            {mcpForms.map((m, idx) => (
              <div key={idx} className="border rounded-lg p-3 mb-2 bg-gray-50 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-500">Server #{idx + 1}</span>
                  <button type="button"
                    onClick={() => setMcpForms(prev => prev.filter((_, i) => i !== idx))}
                    className="text-xs text-red-500 hover:underline">remove</button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input placeholder="name (e.g. time)" value={m.name}
                    onChange={e => setMcpForms(prev => prev.map((s, i) => i === idx ? { ...s, name: e.target.value } : s))}
                    className="px-2 py-1.5 border rounded text-sm bg-white" />
                  <input placeholder="command (e.g. python)" value={m.command}
                    onChange={e => setMcpForms(prev => prev.map((s, i) => i === idx ? { ...s, command: e.target.value } : s))}
                    className="px-2 py-1.5 border rounded text-sm bg-white" />
                </div>
                <input placeholder="args (space-separated, e.g. -m my_server --foo)" value={m.args}
                  onChange={e => setMcpForms(prev => prev.map((s, i) => i === idx ? { ...s, args: e.target.value } : s))}
                  className="w-full px-2 py-1.5 border rounded text-sm bg-white" />
                <textarea placeholder="env (KEY=VAL per line, optional)" value={m.env}
                  onChange={e => setMcpForms(prev => prev.map((s, i) => i === idx ? { ...s, env: e.target.value } : s))}
                  className="w-full px-2 py-1.5 border rounded text-sm bg-white font-mono h-16 resize-none" />
              </div>
            ))}
          </div>

          <button onClick={handleSubmit}
            disabled={!form.name.trim() || !form.soul_md.trim()}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">
            {isEdit ? 'Save Changes' : 'Create Template'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Templates() {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<Template | undefined>()
  const [showCreate, setShowCreate] = useState(false)

  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => templatesApi.list(),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => templatesApi.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['templates'] }),
  })

  const duplicateMutation = useMutation({
    mutationFn: (t: Template) => templatesApi.create({
      name: `${t.name} (copy)`,
      description: t.description,
      soul_md: t.soul_md,
      model_id: t.model_id,
      model_display_name: null,
      model_api_name: null,
      provider_name: null,
      tools: t.tools,
      mcp_servers: t.mcp_servers,
      max_ram: t.max_ram,
      max_cpu: t.max_cpu,
      timeout_minutes: t.timeout_minutes,
      tags: t.tags,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['templates'] }),
  })

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Templates</h1>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium">
          <Plus className="h-4 w-4" /> New Template
        </button>
      </div>

      {templates.length === 0 ? (
        <div className="bg-white rounded-lg border p-8 text-center text-gray-500">
          <Boxes className="h-12 w-12 mx-auto mb-3 text-gray-300" />
          <p>No templates yet</p>
          <p className="text-sm mt-1">Create a template to define agent roles</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map(t => (
            <div key={t.id} className="bg-white rounded-lg border p-4 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-2">
                <h3 className="font-semibold text-gray-900">{t.name}</h3>
                <div className="flex gap-1">
                  <button onClick={() => setEditing(t)} className="p-1 rounded hover:bg-gray-100" title="Edit">
                    <Edit2 className="h-4 w-4 text-gray-400" />
                  </button>
                  <button onClick={() => duplicateMutation.mutate(t)} className="p-1 rounded hover:bg-gray-100" title="Duplicate">
                    <Copy className="h-4 w-4 text-gray-400" />
                  </button>
                  <button onClick={() => { if (confirm('Delete this template?')) deleteMutation.mutate(t.id) }}
                    className="p-1 rounded hover:bg-red-50" title="Delete">
                    <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500" />
                  </button>
                </div>
              </div>
              <p className="text-sm text-gray-500 mb-3 line-clamp-2">{t.description}</p>
              <div className="flex flex-wrap gap-1.5">
                {t.model_id ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                    {t.provider_name ? `${t.provider_name} / ` : ''}{t.model_display_name || t.model_api_name}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                    <AlertTriangle className="h-3 w-3" /> Not configured
                  </span>
                )}
                {t.tools.map(s => (
                  <span key={s} className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{s}</span>
                ))}
              </div>
              <div className="mt-2 text-xs text-gray-400">
                RAM: {t.max_ram} | CPU: {t.max_cpu / 1000}% | Timeout: {t.timeout_minutes}m
              </div>
            </div>
          ))}
        </div>
      )}

      {(showCreate || editing) && (
        <TemplateForm
          template={editing}
          onClose={() => { setShowCreate(false); setEditing(undefined) }}
        />
      )}
    </div>
  )
}

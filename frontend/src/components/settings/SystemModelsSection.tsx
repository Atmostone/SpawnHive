import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { providersApi, workspaceApi } from '@/api/client'
import type { LLMModel, Provider, SystemModels } from '@/types'
import { Save } from 'lucide-react'

const KINDS: Array<{ key: keyof SystemModels; label: string; hint: string }> = [
  {
    key: 'orchestrator_model_id',
    label: 'Orchestrator',
    hint: 'Used for decomposition, template selection, and result evaluation.',
  },
  {
    key: 'chat_model_id',
    label: 'Chat',
    hint: 'Powers the chat panel where you talk to the orchestrator.',
  },
  {
    key: 'memory_extractor_model_id',
    label: 'Memory extractor',
    hint: 'Extracts durable facts from completed tasks (only when memory_mode=structured).',
  },
  {
    key: 'quality_judge_model_id',
    label: 'Quality judge',
    hint: 'LLM-as-judge for quality rubric scoring. Falls back to the orchestrator model when unset.',
  },
]

export function SystemModelsSection({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<SystemModels | null>(null)
  const [saved, setSaved] = useState(false)

  const { data: current } = useQuery({
    queryKey: ['workspaces', 'system-models'],
    queryFn: workspaceApi.getSystemModels,
  })

  const { data: providers } = useQuery({
    queryKey: ['providers'],
    queryFn: providersApi.list,
  })

  useEffect(() => {
    if (current && draft === null) setDraft(current)
  }, [current, draft])

  const update = useMutation({
    mutationFn: (data: Partial<SystemModels>) => workspaceApi.updateSystemModels(data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['workspaces', 'system-models'] })
      setDraft(data)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    },
  })

  return (
    <div className="bg-white rounded-lg border p-4 mb-4">
      <h2 className="font-semibold mb-3">System Models</h2>
      <p className="text-xs text-gray-500 mb-3">
        Assign which model is used by each system role. Templates pick their own model
        independently (in the Templates page).
      </p>
      <div className="space-y-3">
        {KINDS.map(({ key, label, hint }) => (
          <div key={key}>
            <label className="block text-sm font-medium text-gray-700">{label}</label>
            <p className="text-xs text-gray-500 mb-1">{hint}</p>
            <ModelSelect
              providers={providers ?? []}
              value={draft?.[key] ?? null}
              disabled={!canEdit}
              onChange={(v) => setDraft((d) => (d ? { ...d, [key]: v } : d))}
            />
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => draft && update.mutate(draft)}
            disabled={update.isPending || draft === null}
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded text-sm disabled:opacity-50"
          >
            <Save className="h-4 w-4" /> {saved ? 'Saved!' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}

export function ModelSelect({
  providers,
  value,
  onChange,
  disabled,
  placeholder = '— Not configured —',
}: {
  providers: Provider[]
  value: string | null
  onChange: (id: string | null) => void
  disabled?: boolean
  placeholder?: string
}) {
  const grouped = useGroupedModels(providers)
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      className="w-full px-2 py-1.5 border rounded text-sm disabled:bg-gray-50"
    >
      <option value="">{placeholder}</option>
      {grouped.map(({ provider, models }) => (
        <optgroup key={provider.id} label={provider.name}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

function useGroupedModels(providers: Provider[]): {
  provider: Provider
  models: LLMModel[]
}[] {
  const queries = useQuery({
    queryKey: ['providers', 'all-models', providers.map((p) => p.id).sort().join(',')],
    enabled: providers.length > 0,
    queryFn: async () => {
      const groups = await Promise.all(
        providers.map(async (p) => ({
          provider: p,
          models: await providersApi.listModels(p.id),
        })),
      )
      return groups
    },
  })
  return queries.data ?? []
}

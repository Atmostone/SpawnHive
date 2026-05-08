import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { agentsApi, type SwitchModelBody } from '@/api/client'
import { X } from 'lucide-react'

const COMMON_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
] as const

interface Props {
  containerId: string
  agentName: string
  onClose: () => void
}

export default function SwitchModelModal({ containerId, agentName, onClose }: Props) {
  const [preset, setPreset] = useState<string>(COMMON_MODELS[0])
  const [customModel, setCustomModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [success, setSuccess] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (body: SwitchModelBody) => agentsApi.switchModel(containerId, body),
    onSuccess: () => {
      setSuccess('Model switch queued')
      setError(null)
      setTimeout(onClose, 1200)
    },
    onError: (err: Error) => {
      setError(err.message || 'Failed to switch model')
      setSuccess(null)
    },
  })

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    const model = customModel.trim() || preset.trim()
    const body: SwitchModelBody = {}
    if (model) body.model = model
    if (baseUrl.trim()) body.base_url = baseUrl.trim()
    if (apiKey.trim()) body.api_key = apiKey.trim()
    if (!body.model && !body.base_url && !body.api_key) {
      setError('Provide at least one of model, base URL, or API key')
      return
    }
    mutation.mutate(body)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div>
            <h2 className="font-semibold text-gray-900">Switch Model</h2>
            <p className="text-xs text-gray-500 truncate">{agentName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-100 text-gray-500"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={submit} className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Common model
            </label>
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {COMMON_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Custom model (overrides preset)
            </label>
            <input
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="e.g. gpt-4o-2024-11-20"
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Base URL (optional)
            </label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              API key (optional)
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
              {error}
            </div>
          )}
          {success && (
            <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1.5">
              {success}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending}
              className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {mutation.isPending ? 'Switching...' : 'Switch'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

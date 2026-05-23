import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { agentsApi, providersApi, type SwitchModelBody } from '@/api/client'
import { X } from 'lucide-react'
import { ModelSelect } from '@/components/settings/SystemModelsSection'

interface Props {
  containerId: string
  agentName: string
  onClose: () => void
}

export default function SwitchModelModal({ containerId, agentName, onClose }: Props) {
  const [modelId, setModelId] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: providersApi.list,
  })

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
    if (!modelId) {
      setError('Pick a model first')
      return
    }
    mutation.mutate({ model_id: modelId })
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
              Model
            </label>
            <ModelSelect
              providers={providers}
              value={modelId}
              onChange={setModelId}
              placeholder="— Pick a model —"
            />
            <p className="text-xs text-gray-500 mt-1">
              Manage providers and models in Settings → Providers & Models.
            </p>
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
              disabled={mutation.isPending || !modelId}
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

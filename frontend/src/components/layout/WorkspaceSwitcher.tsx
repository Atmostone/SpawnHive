import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { authApi } from '../../api/client'
import { useAuth } from '../../stores/auth'

export default function WorkspaceSwitcher() {
  const nav = useNavigate()
  const { user, workspaces, workspaceId, setWorkspaces, setWorkspaceId, logout } = useAuth()

  useEffect(() => {
    if (workspaces.length === 0 && user) {
      authApi.me().then((m) => setWorkspaces(m.workspaces)).catch(() => {})
    }
  }, [user, workspaces.length, setWorkspaces])

  if (!user) return null

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b bg-white">
      <span className="text-sm text-gray-500">Workspace:</span>
      <select
        value={workspaceId ?? ''}
        onChange={(e) => {
          setWorkspaceId(e.target.value)
          window.location.reload()
        }}
        className="text-sm border rounded px-2 py-1"
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name} ({w.role})
          </option>
        ))}
      </select>
      <div className="ml-auto flex items-center gap-3 text-sm text-gray-700">
        <span>{user.email}</span>
        <button
          onClick={() => {
            logout()
            nav('/login')
          }}
          className="text-indigo-600 hover:underline"
        >
          Logout
        </button>
      </div>
    </div>
  )
}

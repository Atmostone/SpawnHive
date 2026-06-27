import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Terminal, ShieldCheck, ShieldX } from 'lucide-react'
import { qualityApi } from '@/api/client'

/** Executable checker (E-23 / Toolathlon gold.external_eval): the pass/fail
 *  verdict plus the eval + preprocess container log tails, so a user can see WHY
 *  the checker failed — concrete evidence for the "checker is itself unreliable
 *  (~21%)" narrative. Only meaningful on verifiable (checker-graded) runs;
 *  renders nothing otherwise, and shows an empty note for non-Toolathlon tasks. */
export default function ExternalCheckerPanel({
  taskId,
  verifiable = false,
}: {
  taskId: string
  verifiable?: boolean
}) {
  const [open, setOpen] = useState(false)
  const { data, isFetching } = useQuery({
    queryKey: ['external-checker', taskId],
    queryFn: () => qualityApi.getExternalCheckerLogs(taskId),
    enabled: open,
    retry: false,
  })

  // The checker only runs on verifiable benches; on plain runs there is nothing
  // to show, so keep the failure tab uncluttered.
  if (!verifiable) return null

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50"
      >
        <Terminal className="h-4 w-4" />
        Executable checker logs
      </button>
    )
  }

  const verdict = data?.verdict
  return (
    <div className="mt-2 border rounded-lg p-3 bg-gray-50 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700 flex items-center gap-2">
          Executable checker
          {verdict === 'pass' && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 inline-flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" /> pass
            </span>
          )}
          {verdict === 'fail' && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 inline-flex items-center gap-1">
              <ShieldX className="h-3 w-3" /> fail
            </span>
          )}
        </h4>
        <button onClick={() => setOpen(false)} className="text-xs text-gray-400 hover:underline">
          close
        </button>
      </div>

      {isFetching && <p className="text-xs text-gray-400">Loading…</p>}

      {!isFetching && !data?.available && (
        <p className="text-xs text-gray-400">
          No executable-checker run for this task (plain, non-Toolathlon case).
        </p>
      )}

      {!isFetching && data?.available && (
        <>
          <p className="text-[11px] text-gray-500">
            The executable checker (Toolathlon <code>gold.external_eval</code>) is the ground-truth outcome — but it is
            itself unreliable (~21% vs gold). Below are the checker container's log tails (last ~4000 chars); read them
            to tell a real failure from a checker false-fail.
            {data.case_key ? (
              <span className="text-gray-400">
                {' '}
                · {data.config_key} · {data.case_key}
              </span>
            ) : null}
          </p>
          {verdict == null && (
            <p className="text-xs text-amber-600">
              No verdict — the checker could not be evaluated (eval infra error). The log may explain why.
            </p>
          )}
          <LogBlock title="Evaluation log" log={data.eval_log} />
          <LogBlock title="Preprocess log" log={data.preprocess_log} dim />
        </>
      )}
    </div>
  )
}

function LogBlock({ title, log, dim = false }: { title: string; log?: string | null; dim?: boolean }) {
  if (!log) {
    return (
      <div className="text-xs">
        <div className="text-gray-500 mb-0.5">{title}</div>
        <p className="text-gray-400 italic">— none —</p>
      </div>
    )
  }
  return (
    <div className={`text-xs ${dim ? 'opacity-80' : ''}`}>
      <div className="text-gray-500 mb-0.5">
        {title} <span className="text-gray-400">· last {log.length.toLocaleString()} chars</span>
      </div>
      <pre className="bg-gray-900 text-gray-100 rounded p-2 overflow-x-auto max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-snug">
        {log}
      </pre>
    </div>
  )
}

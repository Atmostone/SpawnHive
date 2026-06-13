import { useState } from 'react'
import type { QualityProfile } from '@/types'
import CleanedTracePanel from './CleanedTracePanel'
import TrajectoryScorePanel from './TrajectoryScorePanel'
import EvidenceBankPanel from './EvidenceBankPanel'
import TrajectoryMatchPanel from './TrajectoryMatchPanel'
import CapabilityPanel from './CapabilityPanel'
import VarianceRunPanel from './VarianceRunPanel'
import PerturbationPanel from './PerturbationPanel'
import FailureModePanel from './FailureModePanel'
import HallucinationPanel from './HallucinationPanel'
import CalibrationPanel from './CalibrationPanel'
import AnnotationPanel from './AnnotationPanel'

type Tab = 'trajectory' | 'robustness' | 'failure' | 'annotate'

const TABS: { key: Tab; label: string }[] = [
  { key: 'trajectory', label: 'Trajectory & trace' },
  { key: 'robustness', label: 'Robustness' },
  { key: 'failure', label: 'Failure & facts' },
  { key: 'annotate', label: 'Annotate' },
]

/** Per-run eval drill-down for an experiment run. Mounts the taskId-keyed
 *  quality panels — cleaned trace (E-06), trajectory (E-07), evidence bank
 *  (E-08), trajectory match (E-09), capability (E-13), variance (E-11),
 *  perturbation (E-12), failure modes (E-14), hallucination (E-15),
 *  calibration (E-16) — plus human feedback (E-05). These previously lived
 *  only in TaskDetail, which is unreachable for experiment-origin tasks; here
 *  they are keyed by the run's task_id (returned per run by the results API). */
export default function RunAnalysis({
  taskId,
  profile,
  onSaved,
}: {
  taskId: string
  profile?: QualityProfile | null
  onSaved?: () => void
}) {
  const [tab, setTab] = useState<Tab>('trajectory')
  return (
    <div className="space-y-3">
      <div className="flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${
              tab === t.key
                ? 'border-blue-600 text-blue-600 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {tab === 'trajectory' && (
          <>
            <CleanedTracePanel taskId={taskId} />
            <TrajectoryScorePanel taskId={taskId} />
            <EvidenceBankPanel taskId={taskId} />
            <TrajectoryMatchPanel taskId={taskId} />
          </>
        )}
        {tab === 'robustness' && (
          <>
            <CapabilityPanel taskId={taskId} />
            <VarianceRunPanel taskId={taskId} />
            <PerturbationPanel taskId={taskId} />
          </>
        )}
        {tab === 'failure' && (
          <>
            <FailureModePanel taskId={taskId} />
            <HallucinationPanel taskId={taskId} />
            <CalibrationPanel taskId={taskId} />
          </>
        )}
        {tab === 'annotate' && (
          <AnnotationPanel taskId={taskId} profile={profile ?? null} onSaved={onSaved} />
        )}
      </div>
    </div>
  )
}

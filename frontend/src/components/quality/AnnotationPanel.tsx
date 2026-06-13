import { useQuery } from '@tanstack/react-query'
import { qualityApi } from '@/api/client'
import HumanFeedbackForm from './HumanFeedbackForm'
import type { QualityProfile } from '@/types'

/** Loads the judge profile (unless supplied) + any existing human feedback for a
 *  task, then renders the rating form expanded. Used by the calibration queue and
 *  the experiment results drawer so both annotate through the one feedback API. */
export default function AnnotationPanel({
  taskId,
  profile: profileProp,
  onSaved,
}: {
  taskId: string
  profile?: QualityProfile | null
  onSaved?: () => void
}) {
  const profileQuery = useQuery({
    queryKey: ['quality-profile', taskId],
    queryFn: () => qualityApi.getProfile(taskId),
    enabled: profileProp == null,
  })
  const feedbackQuery = useQuery({
    queryKey: ['human-feedback', taskId],
    queryFn: () => qualityApi.getFeedback(taskId),
  })

  const profile = profileProp ?? profileQuery.data?.quality_profile ?? null
  const loading = feedbackQuery.isLoading || (profileProp == null && profileQuery.isLoading)
  if (loading) return <div className="text-xs text-gray-400 py-2">Loading…</div>

  return (
    <HumanFeedbackForm
      taskId={taskId}
      profile={profile}
      existing={feedbackQuery.data?.human_feedback ?? null}
      defaultOpen
      onSaved={onSaved}
    />
  )
}

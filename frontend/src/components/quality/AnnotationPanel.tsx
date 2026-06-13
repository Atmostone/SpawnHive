import { useQuery } from '@tanstack/react-query'
import { qualityApi } from '@/api/client'
import HumanFeedbackForm from './HumanFeedbackForm'
import type { QualityProfile } from '@/types'

/** Loads the judge profile (unless supplied), the review context (task prompt +
 *  deliverable) and any existing human feedback for a task, then shows what is
 *  being rated above the rating form. Used by the calibration queue and the
 *  experiment results drawer so both annotate through the one feedback API. */
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
  const reviewQuery = useQuery({
    queryKey: ['review-context', taskId],
    queryFn: () => qualityApi.getReview(taskId),
  })
  const feedbackQuery = useQuery({
    queryKey: ['human-feedback', taskId],
    queryFn: () => qualityApi.getFeedback(taskId),
  })

  const profile = profileProp ?? profileQuery.data?.quality_profile ?? null
  const loading =
    feedbackQuery.isLoading ||
    reviewQuery.isLoading ||
    (profileProp == null && profileQuery.isLoading)
  if (loading) return <div className="text-xs text-gray-400 py-2">Loading…</div>

  const review = reviewQuery.data

  return (
    <div className="space-y-3">
      {review && (
        <div className="space-y-3 text-sm">
          {review.description && (
            <Section label="Task">
              <p className="whitespace-pre-wrap text-gray-700">{review.description}</p>
            </Section>
          )}
          {review.reference_answer && (
            <Section label="Reference answer">
              <p className="whitespace-pre-wrap text-gray-700">{review.reference_answer}</p>
            </Section>
          )}
          <Section label="Result">
            {review.result_summary ? (
              <p className="whitespace-pre-wrap text-gray-700">{review.result_summary}</p>
            ) : (
              <p className="text-gray-400 italic">(no result summary)</p>
            )}
          </Section>
          {review.files.map((f) => (
            <Section key={f.name} label={`File · ${f.name}`}>
              {f.binary ? (
                <p className="text-gray-400 italic">(binary or unavailable — not shown)</p>
              ) : (
                <pre className="whitespace-pre-wrap text-xs text-gray-700 max-h-64 overflow-auto">
                  {f.text}
                </pre>
              )}
            </Section>
          ))}
        </div>
      )}

      <HumanFeedbackForm
        taskId={taskId}
        profile={profile}
        existing={feedbackQuery.data?.human_feedback ?? null}
        defaultOpen
        onSaved={onSaved}
      />
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-1">{label}</div>
      <div className="border rounded-lg bg-white px-3 py-2 max-h-72 overflow-auto">{children}</div>
    </div>
  )
}

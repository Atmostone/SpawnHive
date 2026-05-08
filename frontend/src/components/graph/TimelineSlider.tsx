import { useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, Rewind } from 'lucide-react'
import { format } from 'date-fns'

export interface TimelineSliderProps {
  /** Earliest time on the slider — typically `now - 24h`. */
  minTime: Date
  /** Latest time on the slider — typically `now`. Advances as new events arrive. */
  maxTime: Date
  /** Current cutoff position — graph shows events ≤ this time. */
  value: Date
  onChange: (next: Date) => void
  /**
   * When true, the parent treats the cursor as "live" (snapped to maxTime).
   * Used to keep the graph following live updates when the user hasn't scrubbed.
   */
  isLive: boolean
  onLiveChange: (live: boolean) => void
}

const SPEEDS = [1, 5, 30] as const

export default function TimelineSlider({
  minTime,
  maxTime,
  value,
  onChange,
  isLive,
  onLiveChange,
}: TimelineSliderProps) {
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1)
  const playRef = useRef<number | null>(null)

  const minMs = minTime.getTime()
  const maxMs = maxTime.getTime()
  const valueMs = value.getTime()
  const span = Math.max(1, maxMs - minMs)

  // Stop play when we reach the right edge.
  useEffect(() => {
    if (!playing) return
    const tick = () => {
      const now = Date.now()
      // Each tick advances by 1000ms * speed.
      onChange(
        ((): Date => {
          const next = Math.min(maxMs, valueMs + 1000 * speed)
          if (next >= maxMs) {
            // pause when reaching the live edge
            setPlaying(false)
            onLiveChange(true)
            return new Date(maxMs)
          }
          return new Date(next)
        })(),
      )
      // a hint to silence the unused-var warning if Date.now ever gets DCE'd
      void now
    }
    playRef.current = window.setInterval(tick, 1000)
    return () => {
      if (playRef.current != null) {
        window.clearInterval(playRef.current)
        playRef.current = null
      }
    }
  }, [playing, speed, valueMs, maxMs, onChange, onLiveChange])

  const handleSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number(e.target.value)
    onLiveChange(next >= maxMs - 1000)
    onChange(new Date(next))
  }

  const handlePlayPause = () => {
    if (playing) {
      setPlaying(false)
      return
    }
    // If at right edge, restart from the left first.
    if (valueMs >= maxMs - 1000) {
      onLiveChange(false)
      onChange(new Date(minMs))
    }
    setPlaying(true)
  }

  const handleRewind = () => {
    onLiveChange(false)
    onChange(new Date(minMs))
  }

  const liveLabel = useMemo(() => {
    const d = new Date(valueMs)
    return `${format(d, 'HH:mm:ss')} — ${format(d, 'MMM d')}`
  }, [valueMs])

  // Thumb position as a percentage for the floating label.
  const thumbPct = ((valueMs - minMs) / span) * 100

  return (
    <div className="border-t border-gray-200 bg-white px-4 py-3">
      <div className="relative">
        <input
          type="range"
          min={minMs}
          max={maxMs}
          step={1000}
          value={valueMs}
          onChange={handleSlider}
          className="w-full accent-blue-600"
          aria-label="Timeline cutoff"
        />
        <div
          className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded bg-gray-900 px-2 py-0.5 text-[11px] font-medium text-white shadow"
          style={{ left: `${Math.min(100, Math.max(0, thumbPct))}%` }}
        >
          {liveLabel}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-gray-600">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRewind}
            className="flex h-7 w-7 items-center justify-center rounded border border-gray-200 hover:bg-gray-50"
            title="Rewind to start"
          >
            <Rewind className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handlePlayPause}
            className="flex h-7 w-7 items-center justify-center rounded border border-gray-200 hover:bg-gray-50"
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
          <div className="flex items-center gap-1 text-[11px] text-gray-500">
            Speed
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                className={
                  'rounded px-1.5 py-0.5 ' +
                  (speed === s
                    ? 'bg-blue-100 text-blue-700'
                    : 'text-gray-500 hover:bg-gray-100')
                }
              >
                {s}x
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span>{format(minTime, 'MMM d HH:mm')}</span>
          <span
            className={
              'rounded px-2 py-0.5 text-[10px] ' +
              (isLive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600')
            }
          >
            {isLive ? 'LIVE' : 'PAUSED'}
          </span>
          <span>{format(maxTime, 'MMM d HH:mm')}</span>
        </div>
      </div>
    </div>
  )
}

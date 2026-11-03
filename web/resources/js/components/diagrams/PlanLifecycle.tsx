import { useEffect, useState } from 'react'

import {
  LABELS,
  PLAN_LIFECYCLE_STAGES,
  PLAY_INTERVAL_MS,
  SEQUENCE,
} from './plan-lifecycle-stages.js'
import type { InteractiveDiagramProps } from './registry.js'

/** `plan:approve` is wider than a column; let it break after the colon only. */
function withBreakAfterColon(command: string) {
  const [head, tail] = command.split(':')
  return tail === undefined ? command : (
    <>
      {head}:<wbr />
      {tail}
    </>
  )
}

export function PlanLifecycle({ locale }: InteractiveDiagramProps) {
  const labels = LABELS[locale]
  const [position, setPosition] = useState(0)
  const [playing, setPlaying] = useState(false)
  const current = SEQUENCE[position]
  const stage = PLAN_LIFECYCLE_STAGES[current.stage]
  const finished = position === SEQUENCE.length - 1

  useEffect(() => {
    if (!playing) return
    if (finished) {
      setPlaying(false)
      return
    }
    const timer = setTimeout(() => setPosition((value) => value + 1), PLAY_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [playing, finished, position])

  const select = (index: number) => {
    setPlaying(false)
    setPosition(SEQUENCE.findIndex((entry) => entry.stage === index))
  }

  const togglePlay = () => {
    if (playing) {
      setPlaying(false)
      return
    }
    if (finished) setPosition(0)
    setPlaying(true)
  }

  return (
    <div className="plan-lifecycle">
      <div className="plan-lifecycle-head">
        <p className="plan-lifecycle-intro">{labels.intro}</p>
        <button type="button" className="plan-lifecycle-play" onClick={togglePlay} aria-pressed={playing}>
          <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
          {playing ? labels.pause : finished ? labels.replay : labels.play}
        </button>
      </div>

      <ol className="plan-lifecycle-track">
        {PLAN_LIFECYCLE_STAGES.map((entry, index) => {
          const state = index === current.stage ? 'current' : index < current.stage ? 'done' : 'todo'
          return (
            <li key={entry.id} className="plan-lifecycle-stage" data-state={state} data-actor={entry.actor}>
              <button
                type="button"
                className="plan-lifecycle-node"
                aria-pressed={index === current.stage}
                onClick={() => select(index)}
              >
                <span className="plan-lifecycle-index" aria-hidden="true">{index + 1}</span>
                <code>{withBreakAfterColon(entry.command)}</code>
                <span className="plan-lifecycle-actor">{labels.actor[entry.actor]}</span>
              </button>
            </li>
          )
        })}
        <li className="plan-lifecycle-loop" aria-hidden="true" data-active={current.step !== undefined}>
          <span>↻ {current.step !== undefined ? labels.step(current.step) : labels.loop}</span>
        </li>
      </ol>

      <div className="plan-lifecycle-detail" aria-live={playing ? 'off' : 'polite'}>
        <p className="plan-lifecycle-detail-title">
          <code>{stage.command}</code>
          <span className="plan-lifecycle-actor" data-actor={stage.actor}>{labels.actor[stage.actor]}</span>
          {current.step !== undefined && <span className="plan-lifecycle-step">{labels.step(current.step)}</span>}
        </p>
        <p>{stage.text[locale]}</p>
        <p className="plan-lifecycle-writes">
          <span>{labels.writes}</span> <code>{stage.writes}</code>
        </p>
        <a href={`#${stage.anchor[locale]}`}>{labels.read}</a>
      </div>
    </div>
  )
}

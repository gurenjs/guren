import { LABELS, PLAN_LIFECYCLE_STAGES, PLAY_INTERVAL_MS, SEQUENCE, type Actor } from './plan-lifecycle-stages.js'
import { PlayButton, usePlayback } from './playback.js'
import type { InteractiveDiagramProps } from './registry.js'

const ACTOR_TONE: Partial<Record<Actor, 'accent' | 'ok'>> = { person: 'accent', agent: 'ok' }

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
  const { position, running, finished, toggle, seek } = usePlayback(SEQUENCE.length, PLAY_INTERVAL_MS)
  const current = SEQUENCE[position]
  const stage = PLAN_LIFECYCLE_STAGES[current.stage]

  const select = (index: number) => seek(SEQUENCE.findIndex((entry) => entry.stage === index))

  return (
    <div className="doc-diagram plan-lifecycle">
      <div className="doc-diagram-head">
        <p className="doc-diagram-intro">{labels.intro}</p>
        <PlayButton running={running} finished={finished} labels={labels} onToggle={toggle} />
      </div>

      <ol className="doc-diagram-list plan-lifecycle-track">
        {PLAN_LIFECYCLE_STAGES.map((entry, index) => {
          const state = index === current.stage ? 'current' : index < current.stage ? 'done' : 'todo'
          return (
            <li key={entry.id} className="plan-lifecycle-stage" data-state={state}>
              <button
                type="button"
                className="doc-diagram-node plan-lifecycle-node"
                aria-pressed={index === current.stage}
                onClick={() => select(index)}
              >
                <span className="doc-diagram-index" aria-hidden="true">{index + 1}</span>
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

      <div className="doc-diagram-detail" aria-live={running ? 'off' : 'polite'}>
        <p className="doc-diagram-detail-title">
          <code>{stage.command}</code>
          <span className="doc-diagram-chip" data-tone={ACTOR_TONE[stage.actor]}>{labels.actor[stage.actor]}</span>
          {current.step !== undefined && <span className="doc-diagram-chip">{labels.step(current.step)}</span>}
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

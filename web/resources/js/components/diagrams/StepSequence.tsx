import { useState } from 'react'

import type { DocLocale } from '../../../../config/site.js'
import { PlayButton, usePlayback } from './playback.js'
import type { InteractiveDiagramProps } from './registry.js'

export type Localized = Record<DocLocale, string>

export interface Actor {
  label: Localized
  tone?: 'accent' | 'ok'
}

export interface SequenceStep {
  actor: Actor
  /** A string is code (a request line, a call); a Localized label is prose. */
  label: string | Localized
  note: Localized
  text: Localized
  /** A heading id on the same page, or a path to another page. */
  link?: { anchor: Localized } | { href: Localized; label: Localized }
  /** Text the guide's mermaid fallback carries in both locales; a test holds the two together. */
  fallback: string
}

export interface Scenario {
  id: string
  label: Localized
  steps: SequenceStep[]
}

export interface SequenceDiagram {
  intro: Localized
  scenarios: Scenario[]
  intervalMs: number
}

const LABELS = {
  en: { scenario: 'Scenario', play: 'Play the flow', pause: 'Pause', replay: 'Play again', read: 'Read the section' },
  ja: { scenario: 'シナリオ', play: '流れを再生', pause: '一時停止', replay: 'もう一度再生', read: 'この節を読む' },
} satisfies Record<DocLocale, unknown>

function StepLabel({ label, locale }: { label: SequenceStep['label']; locale: DocLocale }) {
  return typeof label === 'string' ? <code>{label}</code> : <strong className="doc-diagram-label">{label[locale]}</strong>
}

function linkHref(link: NonNullable<SequenceStep['link']>, locale: DocLocale): string {
  return 'anchor' in link ? `#${link.anchor[locale]}` : link.href[locale]
}

/** A sequence of steps a reader selects or plays, optionally in several scenarios. */
export function StepSequence({ locale, diagram }: InteractiveDiagramProps & { diagram: SequenceDiagram }) {
  const labels = LABELS[locale]
  const [scenarioIndex, setScenarioIndex] = useState(0)
  const scenario = diagram.scenarios[scenarioIndex]
  const { position, running, finished, toggle, seek } = usePlayback(scenario.steps.length, diagram.intervalMs)
  const step = scenario.steps[position]

  const switchScenario = (index: number) => {
    seek(0)
    setScenarioIndex(index)
  }

  return (
    <div className="doc-diagram">
      <div className="doc-diagram-head">
        <p className="doc-diagram-intro">{diagram.intro[locale]}</p>
        <div className="doc-diagram-controls">
          {diagram.scenarios.length > 1 && (
            <div className="doc-diagram-switch" role="group" aria-label={labels.scenario}>
              {diagram.scenarios.map((entry, index) => (
                <button key={entry.id} type="button" aria-pressed={index === scenarioIndex} onClick={() => switchScenario(index)}>
                  {entry.label[locale]}
                </button>
              ))}
            </div>
          )}
          <PlayButton running={running} finished={finished} labels={labels} onToggle={toggle} />
        </div>
      </div>

      <ol className="doc-diagram-list doc-diagram-rows">
        {scenario.steps.map((entry, index) => (
          <li
            key={`${scenario.id}-${index}`}
            className="doc-diagram-row"
            data-state={index === position ? 'current' : index < position ? 'done' : undefined}
          >
            <button type="button" className="doc-diagram-node" aria-pressed={index === position} onClick={() => seek(index)}>
              <span className="doc-diagram-index" aria-hidden="true">{index + 1}</span>
              <span className="doc-diagram-chip" data-tone={entry.actor.tone}>{entry.actor.label[locale]}</span>
              <StepLabel label={entry.label} locale={locale} />
              <span className="doc-diagram-note">{entry.note[locale]}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="doc-diagram-detail" aria-live={running ? 'off' : 'polite'}>
        <p className="doc-diagram-detail-title">
          <span className="doc-diagram-chip" data-tone={step.actor.tone}>{step.actor.label[locale]}</span>
          <StepLabel label={step.label} locale={locale} />
        </p>
        <p>{step.text[locale]}</p>
        {step.link && (
          <a href={linkHref(step.link, locale)}>{'label' in step.link ? step.link.label[locale] : labels.read}</a>
        )}
      </div>
    </div>
  )
}

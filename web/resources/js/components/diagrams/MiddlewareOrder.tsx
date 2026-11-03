import { useLayoutEffect, useRef, useState } from 'react'

import { LABELS, MIDDLEWARE_STEPS, ORDERS, type Order, type StepKind } from './middleware-order-steps.js'
import { PlayButton, usePlayback } from './playback.js'
import type { InteractiveDiagramProps } from './registry.js'

const PLAY_INTERVAL_MS = 1100
const MOVE_MS = 450
const KIND_TONE: Partial<Record<StepKind, 'accent' | 'ok'>> = { name: 'accent', function: 'ok' }

/**
 * Rows render in the current order, so a screen reader reads what is on screen.
 * The move is animated from each row's offsetTop at the previous order, which
 * neither scrolling nor an in-flight transform changes.
 */
function useReorderAnimation(order: Order) {
  const list = useRef<HTMLOListElement>(null)
  const tops = useRef(new Map<string, number>())

  useLayoutEffect(() => {
    const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const row of Array.from(list.current?.children ?? []) as HTMLElement[]) {
      const id = row.dataset.id!
      const before = tops.current.get(id)
      tops.current.set(id, row.offsetTop)
      if (!animate || before === undefined || before === row.offsetTop) continue
      for (const running of row.getAnimations()) running.cancel()
      row.animate(
        [{ transform: `translateY(${before - row.offsetTop}px)` }, { transform: 'translateY(0)' }],
        { duration: MOVE_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
      )
    }
  }, [order])

  return list
}

export function MiddlewareOrder({ locale }: InteractiveDiagramProps) {
  const labels = LABELS[locale]
  const [order, setOrder] = useState<Order>('written')
  // An index into the run order, so playback and a clicked row move the same marker.
  const { position, running, finished, start, toggle, seek } = usePlayback(
    ORDERS.run.length,
    PLAY_INTERVAL_MS,
    ORDERS.run.indexOf('inlineA'),
  )
  const list = useReorderAnimation(order)
  const step = MIDDLEWARE_STEPS[ORDERS.run[position]]

  const switchOrder = (next: Order) => {
    seek(position)
    setOrder(next)
  }

  const play = () => {
    if (order === 'run') return toggle()
    setOrder('run')
    start(0)
  }

  return (
    <div className="doc-diagram middleware-order">
      <div className="doc-diagram-head">
        <p className="doc-diagram-intro">{labels.intro}</p>
        <div className="doc-diagram-controls">
          <div className="doc-diagram-switch" role="group" aria-label={labels.orderGroup}>
            {(['written', 'run'] as const).map((value) => (
              <button key={value} type="button" aria-pressed={order === value} onClick={() => switchOrder(value)}>
                {labels.order[value]}
              </button>
            ))}
          </div>
          <PlayButton running={running} finished={finished} labels={labels} onToggle={play} />
        </div>
      </div>

      <ol ref={list} className="doc-diagram-list doc-diagram-rows middleware-order-list">
        {ORDERS[order].map((id, index) => {
          const entry = MIDDLEWARE_STEPS[id]
          const runIndex = ORDERS.run.indexOf(id)
          const muted = order === 'written' && entry.kind === 'router'
          const state = runIndex === position ? 'current' : order === 'run' && runIndex < position ? 'done' : undefined
          return (
            <li key={id} data-id={id} className="doc-diagram-row" data-state={state} data-muted={muted}>
              <button
                type="button"
                className="doc-diagram-node"
                aria-pressed={runIndex === position}
                onClick={() => seek(runIndex)}
              >
                <span className="doc-diagram-index" aria-hidden="true">{index + 1}</span>
                <span className="doc-diagram-chip" data-tone={KIND_TONE[entry.kind]}>{labels.kind[entry.kind]}</span>
                <code>{entry.code}</code>
                <span className="doc-diagram-note">{muted ? labels.added : entry.where[locale]}</span>
              </button>
            </li>
          )
        })}
      </ol>

      <div className="doc-diagram-detail" aria-live={running ? 'off' : 'polite'}>
        <p className="doc-diagram-detail-title">
          <span className="doc-diagram-chip" data-tone={KIND_TONE[step.kind]}>{labels.kind[step.kind]}</span>
          <code>{step.code}</code>
          <span className="doc-diagram-note">{step.where[locale]}</span>
        </p>
        <p>{step.text[locale]}</p>
      </div>
    </div>
  )
}

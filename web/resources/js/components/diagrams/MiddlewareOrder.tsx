import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { LABELS, MIDDLEWARE_STEPS, ORDERS, PLAY_INTERVAL_MS, type Order } from './middleware-order-steps.js'
import type { InteractiveDiagramProps } from './registry.js'

const MOVE_MS = 450

/**
 * Rows are rendered in the current order, so a screen reader reads what is on
 * screen; the move between orders is animated by measuring each row before and
 * after React reorders it.
 */
function useReorderAnimation(order: Order) {
  const rows = useRef(new Map<string, HTMLLIElement>())
  const tops = useRef(new Map<string, number>())

  useLayoutEffect(() => {
    const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const [id, row] of rows.current) {
      const top = row.getBoundingClientRect().top
      const before = tops.current.get(id)
      tops.current.set(id, top)
      if (!animate || before === undefined || before === top) continue
      row.animate(
        [{ transform: `translateY(${before - top}px)` }, { transform: 'translateY(0)' }],
        { duration: MOVE_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
      )
    }
  }, [order])

  return (id: string) => (row: HTMLLIElement | null) => {
    if (row) rows.current.set(id, row)
    else rows.current.delete(id)
  }
}

export function MiddlewareOrder({ locale }: InteractiveDiagramProps) {
  const labels = LABELS[locale]
  const [order, setOrder] = useState<Order>('written')
  const [selected, setSelected] = useState('inlineA')
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(-1)
  const rowRef = useReorderAnimation(order)
  const ids = ORDERS[order]
  const finished = position === ORDERS.run.length - 1
  const step = MIDDLEWARE_STEPS[selected]

  useEffect(() => {
    if (!playing) return
    if (finished) {
      setPlaying(false)
      return
    }
    const timer = setTimeout(() => {
      setSelected(ORDERS.run[position + 1])
      setPosition(position + 1)
    }, PLAY_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [playing, finished, position])

  const switchOrder = (next: Order) => {
    setPlaying(false)
    setPosition(-1)
    setOrder(next)
  }

  const togglePlay = () => {
    if (playing) {
      setPlaying(false)
      return
    }
    setOrder('run')
    if (finished || position === -1) {
      setPosition(0)
      setSelected(ORDERS.run[0])
    }
    setPlaying(true)
  }

  const select = (id: string) => {
    setPlaying(false)
    setSelected(id)
  }

  return (
    <div className="middleware-order">
      <div className="middleware-order-head">
        <p className="middleware-order-intro">{labels.intro}</p>
        <div className="middleware-order-controls">
          <div className="middleware-order-switch" role="group" aria-label={labels.orderGroup}>
            {(['written', 'run'] as const).map((value) => (
              <button key={value} type="button" aria-pressed={order === value} onClick={() => switchOrder(value)}>
                {labels.order[value]}
              </button>
            ))}
          </div>
          <button type="button" className="middleware-order-play" onClick={togglePlay} aria-pressed={playing}>
            <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
            {playing ? labels.pause : finished ? labels.replay : labels.play}
          </button>
        </div>
      </div>

      <ol className="middleware-order-list">
        {ids.map((id, index) => {
          const entry = MIDDLEWARE_STEPS[id]
          const passed = order === 'run' && ORDERS.run.indexOf(id) < position
          return (
            <li
              key={id}
              ref={rowRef(id)}
              className="middleware-order-row"
              data-kind={entry.kind}
              data-current={id === selected}
              data-passed={passed}
              data-muted={order === 'written' && entry.kind === 'router'}
            >
              <button type="button" aria-pressed={id === selected} onClick={() => select(id)}>
                <span className="middleware-order-index" aria-hidden="true">{index + 1}</span>
                <span className="middleware-order-kind">{labels.kind[entry.kind]}</span>
                <code>{entry.code}</code>
                <span className="middleware-order-where">
                  {order === 'written' && entry.kind === 'router' ? labels.added : entry.where[locale]}
                </span>
              </button>
            </li>
          )
        })}
      </ol>

      <div className="middleware-order-detail" aria-live={playing ? 'off' : 'polite'}>
        <p className="middleware-order-detail-title">
          <span className="middleware-order-kind" data-kind={step.kind}>{labels.kind[step.kind]}</span>
          <code>{step.code}</code>
          <span className="middleware-order-where">{step.where[locale]}</span>
        </p>
        <p>{step.text[locale]}</p>
      </div>
    </div>
  )
}

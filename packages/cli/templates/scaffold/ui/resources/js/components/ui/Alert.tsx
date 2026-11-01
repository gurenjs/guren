// guren-ui: Alert v1. `guren upgrade` replaces this file only while it is unedited.
import type { HTMLAttributes } from 'react'

export type AlertTone = 'ok' | 'warn' | 'danger'

const KEYS: Record<AlertTone, { text: string; color: string }> = {
  ok: { text: 'ok', color: 'text-g-ok' },
  warn: { text: 'warn', color: 'text-g-warn' },
  danger: { text: 'error', color: 'text-g-danger' },
}

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  tone?: AlertTone
}

/** A message as a diagnostic row: the tone as a mono key in a fixed gutter, a hairline, the body. */
export function Alert({ tone = 'ok', className, children, ...props }: AlertProps) {
  const key = KEYS[tone]
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={['flex gap-3 border-y border-g-line py-2.5 text-sm', className].filter(Boolean).join(' ')}
      {...props}
    >
      <span className={`w-10 shrink-0 text-right font-mono text-xs font-bold leading-5 ${key.color}`}>{key.text}</span>
      <span className="text-g-text">{children}</span>
    </div>
  )
}

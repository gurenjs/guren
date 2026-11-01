// guren-ui: Label v1. `guren upgrade` replaces this file only while it is unedited.
import type { LabelHTMLAttributes } from 'react'

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={['block text-sm font-bold text-g-heading', className].filter(Boolean).join(' ')} {...props} />
}

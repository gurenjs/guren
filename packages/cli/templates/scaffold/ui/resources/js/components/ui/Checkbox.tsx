// guren-ui: Checkbox v1. `guren upgrade` replaces this file only while it is unedited.
import type { InputHTMLAttributes, ReactNode } from 'react'

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** The text beside the box; the wrapping `<label>` makes it the box's accessible name. */
  label: ReactNode
}

/** `className` goes to the wrapping `<label>`; every other prop to the `<input>`. */
export function Checkbox({ label, className, ...props }: CheckboxProps) {
  return (
    <label className={['flex items-center gap-2', className].filter(Boolean).join(' ')}>
      <input type="checkbox" className="h-4 w-4 rounded accent-g-accent" {...props} />
      {label}
    </label>
  )
}

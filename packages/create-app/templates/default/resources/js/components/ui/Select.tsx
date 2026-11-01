// guren-ui: Select v2. `guren upgrade` replaces this file only while it is unedited.
import type { SelectHTMLAttributes } from 'react'

const SELECT_CLASS =
  'w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none focus:outline-solid focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent aria-invalid:border-g-danger-chip'

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Rendered as `<option>` elements ahead of any children. */
  options?: readonly SelectOption[]
}

/** `aria-invalid` turns the border to the danger tone. */
export function Select({ options, className, children, ...props }: SelectProps) {
  return (
    <select className={[SELECT_CLASS, className].filter(Boolean).join(' ')} {...props}>
      {options?.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
      {children}
    </select>
  )
}

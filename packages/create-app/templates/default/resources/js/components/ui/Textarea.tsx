// guren-ui: Textarea v1. `guren upgrade` replaces this file only while it is unedited.
import type { TextareaHTMLAttributes } from 'react'

const TEXTAREA_CLASS =
  'w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent aria-invalid:border-g-danger-chip'

/** `aria-invalid` turns the border to the danger tone. */
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={[TEXTAREA_CLASS, className].filter(Boolean).join(' ')} {...props} />
}

// guren-ui: Button v1. `guren upgrade` replaces this file only while it is unedited.
import type { ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
export type ButtonSize = 'md' | 'sm'

export interface ButtonClassOptions {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Full width, for a form's one submit. */
  block?: boolean
  className?: string
}

// Whole strings rather than fragments, so a class can be found by searching for it.
const CLASSES: Record<ButtonVariant, Record<ButtonSize, string>> = {
  primary: {
    md: 'rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down',
    sm: 'rounded-g-ctl bg-g-accent px-3 py-1 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down',
  },
  secondary: {
    md: 'rounded-g-ctl border border-g-line-strong bg-g-panel px-4 py-2 text-sm font-bold text-g-text transition hover:border-g-muted',
    sm: 'rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-1 text-sm font-bold text-g-text transition hover:border-g-muted',
  },
  danger: {
    md: 'rounded-g-ctl border border-g-danger-chip px-4 py-2 text-sm font-bold text-g-danger transition hover:bg-g-danger-tint',
    sm: 'rounded-g-ctl border border-g-danger-chip px-3 py-1 text-sm font-bold text-g-danger transition hover:bg-g-danger-tint',
  },
  ghost: {
    md: 'rounded-g-ctl px-4 py-2 text-sm font-bold text-g-accent-text transition hover:bg-g-accent-tint',
    sm: 'rounded-g-ctl px-3 py-1 text-sm font-bold text-g-accent-text transition hover:bg-g-accent-tint',
  },
}

/** The classes of a button, for an element that is not one: an Inertia `<Link>` or an `<a>`. */
export function buttonClass({ variant = 'primary', size = 'md', block = false, className }: ButtonClassOptions = {}): string {
  return [block && 'w-full', CLASSES[variant][size], 'disabled:cursor-not-allowed disabled:opacity-45', className]
    .filter(Boolean)
    .join(' ')
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, Omit<ButtonClassOptions, 'className'> {}

export function Button({ variant, size, block, className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonClass({ variant, size, block, className })} {...props} />
}

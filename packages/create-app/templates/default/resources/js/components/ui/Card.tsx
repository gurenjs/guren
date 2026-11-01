// guren-ui: Card v1. `guren upgrade` replaces this file only while it is unedited.
import type { HTMLAttributes, ReactNode } from 'react'

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** `article` for one item of a list. */
  as?: 'section' | 'article' | 'div'
  title?: ReactNode
}

export function Card({ as: Element = 'section', title, className, children, ...props }: CardProps) {
  return (
    <Element className={['rounded-g-card border border-g-line bg-g-panel p-4 shadow-g-card', className].filter(Boolean).join(' ')} {...props}>
      {title ? <h2 className="mb-3 text-lg font-bold text-g-heading">{title}</h2> : null}
      {children}
    </Element>
  )
}

import type { ReactNode } from 'react'

export function InlineCode({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.92em] text-crimson-300">{children}</code>
}

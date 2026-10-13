import { Link } from '@inertiajs/react'
import type { ReactNode } from 'react'
import { OWN_REPO_LINK_REL } from '../../../config/site.js'

/** `external` is for the project's own repositories: OWN_REPO_LINK_REL keeps the referrer. */
export function TextLink({ href, external, children }: { href: string; external?: boolean; children: ReactNode }) {
  const className =
    'font-semibold text-crimson-300 underline decoration-crimson-300/40 underline-offset-4 transition hover:decoration-crimson-300'
  return external ? (
    <a href={href} target="_blank" rel={OWN_REPO_LINK_REL} className={className}>
      {children}
    </a>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  )
}

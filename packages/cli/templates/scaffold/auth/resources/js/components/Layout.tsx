import { Link, usePage } from '@inertiajs/react'
import type { PropsWithChildren } from 'react'

export default function Layout({ children }: PropsWithChildren) {
  const { props } = usePage<{ auth?: { user?: { name?: string } } }>()
  const user = props.auth?.user
  const navButtonClass =
    'rounded-g-ctl border border-g-line-strong px-3 py-1 text-g-text transition hover:border-g-muted'

  return (
    <div className="min-h-screen bg-g-page font-sans text-g-text">
      <header className="border-b border-g-line bg-g-panel">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-bold text-g-heading">
            Guren
          </Link>
          <nav className="flex items-center gap-4 text-sm text-g-text-2">
            <Link href="/" className="transition hover:text-g-heading">
              Home
            </Link>
            <Link href="/dashboard" className="transition hover:text-g-heading">
              Dashboard
            </Link>
            {user ? (
              // Inertia's HTTP client copies the XSRF-TOKEN cookie into the
              // request header. A native <form> does not, so CSRF protection
              // would answer 403 and leave the session signed in.
              <Link href="/logout" method="post" as="button" className={navButtonClass}>
                Log out
              </Link>
            ) : (
              <Link href="/login" className={navButtonClass}>
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-12">
        {children}
      </main>
    </div>
  )
}

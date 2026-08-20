import { Link, usePage } from '@inertiajs/react'
import type { PropsWithChildren } from 'react'

export default function Layout({ children }: PropsWithChildren) {
  const { props } = usePage<{ auth?: { user?: { name?: string } } }>()
  const user = props.auth?.user
  const navButtonClass =
    'rounded border border-emerald-500 px-3 py-1 text-emerald-200 transition hover:bg-emerald-500 hover:text-slate-950'

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-semibold text-emerald-300">
            Guren
          </Link>
          <nav className="flex items-center gap-4 text-sm text-slate-300">
            <Link href="/" className="transition hover:text-emerald-200">
              Home
            </Link>
            <Link href="/dashboard" className="transition hover:text-emerald-200">
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

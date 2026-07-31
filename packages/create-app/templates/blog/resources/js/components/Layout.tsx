import { Link, usePage } from '@inertiajs/react'
import type { PropsWithChildren } from 'react'

export default function Layout({ children }: PropsWithChildren) {
  const { props } = usePage<{ auth?: { user?: { name?: string } } }>()
  const user = props.auth?.user

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-semibold text-emerald-300">
            __APP_TITLE__
          </Link>
          <nav className="flex items-center gap-4 text-sm text-slate-300">
            <Link href="/posts" className="transition hover:text-emerald-200">
              Posts
            </Link>
            {user ? (
              <>
                <Link href="/posts/create" className="transition hover:text-emerald-200">
                  Write
                </Link>
                <Link href="/dashboard" className="transition hover:text-emerald-200">
                  Dashboard
                </Link>
                {/* Inertia's Link posts through Axios, which copies the
                    XSRF-TOKEN cookie into the request header. A native <form>
                    POST carries neither that header nor a _token field, so CSRF
                    protection rejects it and the session survives the click. */}
                <Link
                  href="/logout"
                  method="post"
                  as="button"
                  className="rounded border border-emerald-500 px-3 py-1 text-emerald-200 transition hover:bg-emerald-500 hover:text-slate-950"
                >
                  Log out
                </Link>
              </>
            ) : (
              <Link
                href="/login"
                className="rounded border border-emerald-500 px-3 py-1 text-emerald-200 transition hover:bg-emerald-500 hover:text-slate-950"
              >
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

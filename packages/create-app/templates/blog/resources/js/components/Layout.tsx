import { Link, usePage } from '@inertiajs/react'
import type { PropsWithChildren } from 'react'

export default function Layout({ children }: PropsWithChildren) {
  const { props } = usePage<{ auth?: { user?: { name?: string } } }>()
  const user = props.auth?.user

  return (
    <div className="min-h-screen bg-g-page font-sans text-g-text">
      <header className="border-b border-g-line bg-g-panel">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-bold text-g-heading">
            __APP_TITLE__
          </Link>
          <nav className="flex items-center gap-4 text-sm text-g-text-2">
            <Link href="/posts" className="transition hover:text-g-heading">
              Posts
            </Link>
            {user ? (
              <>
                <Link href="/posts/create" className="transition hover:text-g-heading">
                  Write
                </Link>
                <Link href="/dashboard" className="transition hover:text-g-heading">
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
                  className="rounded-g-ctl border border-g-line-strong px-3 py-1 text-g-text transition hover:border-g-muted"
                >
                  Log out
                </Link>
              </>
            ) : (
              <Link
                href="/login"
                className="rounded-g-ctl border border-g-line-strong px-3 py-1 text-g-text transition hover:border-g-muted"
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

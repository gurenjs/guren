import { Link, usePage } from '@inertiajs/react'
import type { PropsWithChildren } from 'react'
import { FileText, LayoutDashboard, LogIn, LogOut, UserRound } from 'lucide-react'

type SharedPageProps = {
  auth?: {
    user?: Record<string, unknown> | null
  }
}

type LayoutProps = PropsWithChildren<{
  mainClassName?: string
  wrapperClassName?: string
}>

export default function Layout({ children, mainClassName, wrapperClassName }: LayoutProps) {
  const { props } = usePage<SharedPageProps>()
  const isAuthenticated = Boolean(props.auth?.user)

  const wrapperClasses = ['min-h-screen bg-zinc-50 text-zinc-900 font-sans selection:bg-guren-100 selection:text-guren-700']
  if (wrapperClassName) {
    wrapperClasses.push(wrapperClassName)
  }

  const mainClasses = ['mx-auto w-full px-6 py-12']
  if (mainClassName) {
    mainClasses.push(mainClassName)
  } else {
    mainClasses.push('max-w-3xl')
  }

  return (
    <div className={wrapperClasses.join(' ')}>
      <header className="sticky top-0 z-50 border-b border-b-zinc-200 bg-white/80 backdrop-blur-md border-t-4 border-t-guren-600">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2 text-xl font-bold tracking-tight text-zinc-900 transition hover:opacity-80">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-guren-500 to-guren-700 text-white shadow-sm shadow-guren-200">
              <span className="text-lg font-bold">G</span>
            </div>
            <span>Guren Blog</span>
          </Link>
          <nav className="flex items-center gap-6 text-sm font-medium text-zinc-600">
            <Link href="/posts" className="flex items-center gap-1.5 transition hover:text-guren-600">
              <FileText className="h-4 w-4" aria-hidden />
              Posts
            </Link>
            <Link href="/dashboard" className="flex items-center gap-1.5 transition hover:text-guren-600">
              <LayoutDashboard className="h-4 w-4" aria-hidden />
              Dashboard
            </Link>
            {isAuthenticated ? (
              <Link href="/profile" className="flex items-center gap-1.5 transition hover:text-guren-600">
                <UserRound className="h-4 w-4" aria-hidden />
                Profile
              </Link>
            ) : null}
            {isAuthenticated ? (
              <Link
                href="/logout"
                method="post"
                as="button"
                className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-4 py-1.5 text-white transition hover:bg-zinc-700 hover:shadow-lg"
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden />
                Log out
              </Link>
            ) : (
              <Link
                href="/login"
                className="inline-flex items-center gap-1.5 rounded-full bg-guren-600 px-4 py-1.5 text-white shadow-sm shadow-guren-500/30 transition hover:bg-guren-500 hover:shadow-md hover:shadow-guren-500/30"
              >
                <LogIn className="h-3.5 w-3.5" aria-hidden />
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className={mainClasses.join(' ')}>
        {children}
      </main>
      <footer className="border-t border-zinc-200 bg-white py-12">
        <div className="mx-auto max-w-5xl px-6 text-center text-sm text-zinc-500">
          <p>&copy; {new Date().getFullYear()} Guren Blog. Built with GurenJS.</p>
        </div>
      </footer>
    </div>
  )
}

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

  const wrapperClasses = ['min-h-screen bg-[#FFF5F5] text-[#3C0A0A]']
  if (wrapperClassName) {
    wrapperClasses.push(wrapperClassName)
  }

  const mainClasses = ['mx-auto w-full px-6 py-12']
  if (mainClassName) {
    mainClasses.push(mainClassName)
  } else {
    mainClasses.push('max-w-2xl')
  }

  return (
    <div className={wrapperClasses.join(' ')}>
      <header className="border-b border-[#F4B0B0] bg-[#B71C1C] text-white shadow-sm">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            Guren Blog
          </Link>
          <nav className="flex items-center gap-4 text-sm font-medium">
            <Link href="/posts" className="flex items-center gap-1.5 transition hover:text-[#FFE3E3]">
              <FileText className="h-4 w-4" aria-hidden />
              Posts
            </Link>
            <Link href="/dashboard" className="flex items-center gap-1.5 transition hover:text-[#FFE3E3]">
              <LayoutDashboard className="h-4 w-4" aria-hidden />
              Dashboard
            </Link>
            {isAuthenticated ? (
              <Link href="/profile" className="flex items-center gap-1.5 transition hover:text-[#FFE3E3]">
                <UserRound className="h-4 w-4" aria-hidden />
                Profile
              </Link>
            ) : null}
            {isAuthenticated ? (
              <Link
                href="/logout"
                method="post"
                as="button"
                className="inline-flex items-center gap-1.5 rounded-full border border-white/70 px-4 py-1 text-white transition hover:bg-white hover:text-[#8F1111]"
              >
                <LogOut className="h-4 w-4" aria-hidden />
                Log out
              </Link>
            ) : (
              <Link
                href="/login"
                className="inline-flex items-center gap-1.5 rounded-full border border-white/70 px-4 py-1 text-white transition hover:bg-white hover:text-[#8F1111]"
              >
                <LogIn className="h-4 w-4" aria-hidden />
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className={mainClasses.join(' ')}>
        {children}
      </main>
    </div>
  )
}

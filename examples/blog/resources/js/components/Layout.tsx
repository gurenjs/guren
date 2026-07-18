import { Link, usePage } from '@inertiajs/react'
import { useEffect, useState, type PropsWithChildren } from 'react'
import { route } from '@/.guren/routes.gen'

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
  const [isHydrated, setIsHydrated] = useState(false)

  useEffect(() => {
    setIsHydrated(true)
  }, [])

  const wrapperClasses = ['min-h-screen bg-stone-50 text-stone-800 font-sans selection:bg-guren-100 selection:text-guren-900']
  if (wrapperClassName) {
    wrapperClasses.push(wrapperClassName)
  }

  const mainClasses = ['mx-auto w-full px-6 pt-10 pb-16 sm:pt-12 sm:pb-24']
  if (mainClassName) {
    mainClasses.push(mainClassName)
  } else {
    mainClasses.push('max-w-4xl')
  }

  return (
    <div className={wrapperClasses.join(' ')}>
      <header className="sticky top-0 z-50 bg-white/90 backdrop-blur-lg border-b border-stone-100">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2 transition hover:opacity-80">
            <svg className="h-7 w-auto" viewBox="0 0 299 516" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
              <path fillRule="evenodd" clipRule="evenodd" d="M120.853 0C169.647 25.1364 195.255 83.7877 184.353 136.5C175.756 178.065 136.039 208.749 137.372 253.138C138.729 298.251 168.879 330.194 161.353 377.5C181.444 352.982 200.458 332.078 208.353 300.5C214.367 261.839 179.943 229.848 190.898 190.72C194.731 177.22 208.153 147.3 231.353 136.5C218.919 181.573 237.455 211.003 266.353 245C300.243 280.246 308.266 343.188 284.853 386C253.141 442.376 189.378 465.573 149.853 515.5C121.558 476.749 77.5264 459.842 48.8528 424C-12.4118 347.419 -19.5127 245.133 47.3528 169C80.8397 130.872 165.348 59.327 120.853 0Z" fill="url(#guren-logo-grad)"/>
              <defs>
                <linearGradient id="guren-logo-grad" x1="149.117" y1="0" x2="149.117" y2="515.5" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#FF3C28"/>
                  <stop offset="1" stopColor="#8B0000"/>
                </linearGradient>
              </defs>
            </svg>
            <span className="text-lg font-medium tracking-tight text-stone-900">Guren</span>
          </Link>
          <nav className="flex items-center gap-8 text-sm">
            <Link href={route('posts.index')} className="text-stone-500 transition-colors hover:text-stone-900">
              Posts
            </Link>
            <Link href={route('dashboard')} className="text-stone-500 transition-colors hover:text-stone-900">
              Dashboard
            </Link>
            {isAuthenticated ? (
              <Link href={route('profile.edit')} className="text-stone-500 transition-colors hover:text-stone-900">
                Profile
              </Link>
            ) : null}
            {isAuthenticated ? (
              <Link
                href={route('logout')}
                method="post"
                as="button"
                className="inline-flex items-center rounded-md bg-stone-100 px-4 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-200"
              >
                Log out
              </Link>
            ) : (
              <Link
                href={route('login')}
                className="inline-flex items-center rounded-md bg-guren-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-guren-500"
              >
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className={mainClasses.join(' ')} data-hydrated={isHydrated ? 'true' : 'false'}>
        {children}
      </main>
      <footer className="border-t border-stone-100 py-16">
        <div className="mx-auto max-w-5xl px-6 text-center text-xs tracking-wide text-stone-400">
          <p>&copy; {new Date().getFullYear()} Guren Blog. Built with GurenJS.</p>
        </div>
      </footer>
    </div>
  )
}

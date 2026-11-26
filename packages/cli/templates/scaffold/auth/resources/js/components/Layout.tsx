import { Link, usePage } from '@inertiajs/react'
import { createTranslator, hasTranslation, type I18nPageProps } from '@guren/inertia-client'
import type { NavigationItem } from '@guren/core'
import type { ReactNode } from 'react'

interface LayoutProps {
  children: ReactNode
  /** The wide measure, for a table or a board; a form keeps the narrow one. */
  wide?: boolean
}

type SharedProps = {
  app?: { name?: string }
  auth?: { user?: { name?: string } | null }
  navigation?: NavigationItem[]
  _i18n?: I18nPageProps
}

// Shown when lang/<locale>/layout.json lacks the key, or the app shares no translations.
const ACCOUNT_LABELS = {
  'layout.sign_in': 'Sign in',
  'layout.log_out': 'Log out',
  'layout.profile': 'Profile',
} as const

// The links come from config/navigation.ts: add an entry there rather than a link here.
export default function Layout({ children, wide = false }: LayoutProps) {
  const { props } = usePage<SharedProps>()
  const user = props.auth?.user
  const navigation = props.navigation ?? []
  const i18n = props._i18n
  const label = (key: keyof typeof ACCOUNT_LABELS) =>
    i18n && hasTranslation(i18n, key) ? createTranslator(i18n).t(key) : ACCOUNT_LABELS[key]
  const linkClass = 'transition hover:text-g-heading aria-[current=page]:font-semibold aria-[current=page]:text-g-heading'
  const buttonClass =
    'rounded-g-ctl border border-g-line-strong px-3 py-1 text-g-text transition hover:border-g-muted'

  return (
    <div className="min-h-screen bg-g-page font-sans text-g-text">
      <header className="border-b border-g-line bg-g-panel">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-4">
          <Link href={navigation[0]?.path ?? '/'} className="text-lg font-bold text-g-heading">
            {props.app?.name ?? 'Guren'}
          </Link>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-g-text-2">
            {navigation.map((item) => (
              <Link
                key={item.path}
                href={item.path}
                aria-current={item.current ? 'page' : undefined}
                className={linkClass}
              >
                {item.label}
              </Link>
            ))}
            {user ? (
              <>
                <Link href="/profile" className={linkClass}>
                  {user.name || label('layout.profile')}
                </Link>
                {/* Inertia's HTTP client copies the XSRF-TOKEN cookie into the
                    request header. A native <form> does not, so CSRF protection
                    would answer 403 and leave the session signed in. */}
                <Link href="/logout" method="post" as="button" className={buttonClass}>
                  {label('layout.log_out')}
                </Link>
              </>
            ) : (
              <Link href="/login" className={buttonClass}>
                {label('layout.sign_in')}
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className={`mx-auto px-6 py-12 ${wide ? 'max-w-5xl' : 'max-w-2xl'}`}>
        {children}
      </main>
    </div>
  )
}

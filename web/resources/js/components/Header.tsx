import { Link } from '@inertiajs/react'
import { useState } from 'react'
import { useColorMode } from '../pages/Docs/theme.js'
import { GithubIcon, MenuIcon, MoonIcon, SunIcon } from './icons.js'
import { MobileMenu } from './MobileMenu.js'

interface LocaleLink {
  code: string
  label: string
  href: string
  active?: boolean
}

interface HeaderProps {
  variant: 'home' | 'docs'
  basePath?: string
  locales?: LocaleLink[]
}

function ColorModeButton({ variant }: { variant: 'home' | 'docs' }) {
  const { isDark, setMode } = useColorMode()

  const toggle = () => setMode(isDark ? 'light' : 'dark')

  if (variant === 'home') {
    return (
      <button
        type="button"
        onClick={toggle}
        className="text-white/80 transition hover:text-white"
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {isDark ? <SunIcon className="size-5" /> : <MoonIcon className="size-5" />}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="text-docs-text-muted transition hover:text-docs-accent"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? <SunIcon className="size-5" /> : <MoonIcon className="size-5" />}
    </button>
  )
}

export function Header({ variant, basePath = '/docs', locales = [] }: HeaderProps) {
  const [mobileOpen, setMobileOpen] = useState(false)

  if (variant === 'home') {
    return (
      <>
        <header className="sticky top-0 z-50 border-b border-white/10 bg-black/40 backdrop-blur-xl">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <Link href="/" className="flex items-center gap-3 text-white no-underline">
              <img src="/logo.svg" alt="Guren" className="size-9 rounded-xl p-0.5" />
              <span className="text-lg font-bold tracking-tight">Guren</span>
            </Link>
            <div className="flex items-center gap-5">
              <nav className="hidden items-center gap-6 text-sm font-medium text-white/80 md:flex">
                <Link href="/docs" className="transition hover:text-white">Docs</Link>
                <Link href="/docs/tutorials/overview" className="transition hover:text-white">Tutorials</Link>
                <a
                  href="https://github.com/gurenjs/guren"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 transition hover:text-white"
                >
                  <GithubIcon className="size-4" />
                  GitHub
                </a>
              </nav>
              <ColorModeButton variant="home" />
              <button
                type="button"
                className="text-white/80 transition hover:text-white md:hidden"
                onClick={() => setMobileOpen(true)}
                aria-label="Open menu"
              >
                <MenuIcon className="size-6" />
              </button>
            </div>
          </div>
        </header>
        <MobileMenu
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          basePath={basePath}
          locales={locales}
        />
      </>
    )
  }

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-docs-border bg-docs-page">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-4 px-6 py-3">
          <Link href="/" className="flex items-center gap-3 text-docs-heading no-underline">
            <img src="/logo.svg" alt="Guren Docs" className="size-8 rounded-lg p-0.5" />
            <span className="text-[1.1rem] font-bold tracking-tight">Guren Docs</span>
          </Link>
          <div className="flex flex-wrap items-center gap-5">
            <nav className="hidden items-center gap-6 text-[0.95rem] font-medium md:flex">
              <Link href={basePath} className="text-docs-text no-underline transition hover:text-docs-accent">Guides</Link>
              <Link href={`${basePath}/tutorials/overview`} className="text-docs-text no-underline transition hover:text-docs-accent">Tutorials</Link>
              <a
                href="https://github.com/gurenjs/guren"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 text-docs-text-muted no-underline transition hover:text-docs-accent"
              >
                <GithubIcon className="size-4" />
                GitHub
              </a>
            </nav>
            {locales.length > 1 && (
              <div className="hidden items-center gap-1 border-l border-docs-border pl-4 md:flex">
                {locales.map((locale) => (
                  <Link
                    key={locale.code}
                    href={locale.href}
                    className={`rounded-md px-2.5 py-1 text-[0.85rem] font-semibold no-underline transition ${
                      locale.active
                        ? 'bg-docs-accent-tint text-docs-accent'
                        : 'text-docs-text-muted hover:text-docs-accent'
                    }`}
                  >
                    {locale.label}
                  </Link>
                ))}
              </div>
            )}
            <ColorModeButton variant="docs" />
            <button
              type="button"
              className="text-docs-text-muted transition hover:text-docs-accent md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <MenuIcon className="size-6" />
            </button>
          </div>
        </div>
      </header>
      <MobileMenu
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        basePath={basePath}
        locales={locales}
      />
    </>
  )
}

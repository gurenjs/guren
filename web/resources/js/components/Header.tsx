import { Link } from '@inertiajs/react'
import { useState } from 'react'
import { OWN_REPO_LINK_REL } from '../../../config/site.js'
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
  /** Home only: the side rules of the page frame, for a page laid out in it. */
  framed?: boolean
  /** Docs only: the section named beside the logo. */
  section?: 'Docs' | 'Blog'
}

function ColorModeButton({ variant }: { variant: 'home' | 'docs' }) {
  const { isDark, setMode } = useColorMode()

  const toggle = () => setMode(isDark ? 'light' : 'dark')

  if (variant === 'home') {
    return (
      <button
        type="button"
        onClick={toggle}
        className="text-home-text-2 transition hover:text-home-text"
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
      className="text-docs-text-secondary transition hover:text-docs-accent"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? <SunIcon className="size-5" /> : <MoonIcon className="size-5" />}
    </button>
  )
}

export function Header({ variant, basePath = '/docs', locales = [], framed = false, section = 'Docs' }: HeaderProps) {
  const [mobileOpen, setMobileOpen] = useState(false)

  if (variant === 'home') {
    return (
      <>
        <header className="sticky top-0 z-50 border-b border-home-line bg-home-ground/85 backdrop-blur-xl">
          <div className={`mx-auto flex max-w-6xl items-center justify-between border-home-line px-6 py-3.5 ${framed ? 'lg:border-x' : ''}`}>
            <Link href="/" className="flex items-center gap-2.5 text-home-text no-underline">
              <img src="/logo.svg" alt="" className="size-8 rounded-lg p-0.5" />
              <span className="text-[1.0625rem] font-bold tracking-tight">Guren</span>
            </Link>
            <div className="flex items-center gap-5">
              <nav aria-label="Main" className="hidden items-center gap-6 text-sm font-medium text-home-text-2 md:flex">
                <Link href="/start" className="transition hover:text-home-text">Get started</Link>
                <Link href="/docs" className="transition hover:text-home-text">Docs</Link>
                <Link href="/docs/tutorials/00-overview" className="transition hover:text-home-text">Tutorials</Link>
                <Link href="/docs/agent-course/00-overview" className="transition hover:text-home-text">Agent Course</Link>
                <Link href="/blog" className="transition hover:text-home-text">Blog</Link>
                <a
                  href="https://github.com/gurenjs/guren"
                  target="_blank"
                  rel={OWN_REPO_LINK_REL}
                  className="flex items-center gap-1.5 transition hover:text-home-text"
                >
                  <GithubIcon className="size-4" />
                  GitHub
                </a>
              </nav>
              <ColorModeButton variant="home" />
              <button
                type="button"
                className="text-home-text-2 transition hover:text-home-text md:hidden"
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
            <img src="/logo.svg" alt="" className="size-8 rounded-lg p-0.5" />
            <span className="text-[1.1rem] font-bold tracking-tight">Guren {section}</span>
          </Link>
          <div className="flex flex-wrap items-center gap-5">
            <nav aria-label="Main" className="hidden items-center gap-6 text-[0.95rem] font-medium md:flex">
              <Link href={basePath} className="text-docs-text no-underline transition hover:text-docs-accent">Guides</Link>
              <Link href={`${basePath}/tutorials/00-overview`} className="text-docs-text no-underline transition hover:text-docs-accent">Tutorials</Link>
              <Link href={`${basePath}/agent-course/00-overview`} className="text-docs-text no-underline transition hover:text-docs-accent">Agent Course</Link>
              <Link href="/blog" className="text-docs-text no-underline transition hover:text-docs-accent">Blog</Link>
              <a
                href="https://github.com/gurenjs/guren"
                target="_blank"
                rel={OWN_REPO_LINK_REL}
                className="flex items-center gap-1.5 text-docs-text-secondary no-underline transition hover:text-docs-accent"
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
                        : 'text-docs-text-secondary hover:text-docs-accent'
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
              className="text-docs-text-secondary transition hover:text-docs-accent md:hidden"
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

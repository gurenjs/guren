import { Link } from '@inertiajs/react'
import { useEffect } from 'react'
import { GithubIcon, XIcon } from './icons.js'

interface LocaleLink {
  code: string
  label: string
  href: string
  active?: boolean
}

interface MobileMenuProps {
  open: boolean
  onClose: () => void
  basePath: string
  locales?: LocaleLink[]
}

export function MobileMenu({ open, onClose, basePath, locales = [] }: MobileMenuProps) {
  useEffect(() => {
    if (!open) return
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = original
    }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      {/* Drawer */}
      <aside className="absolute top-0 right-0 h-full w-72 animate-slide-in-right bg-docs-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-docs-border px-5 py-4">
          <span className="text-lg font-bold text-docs-heading">Menu</span>
          <button
            type="button"
            onClick={onClose}
            className="text-docs-text-muted transition hover:text-docs-heading"
            aria-label="Close menu"
          >
            <XIcon className="size-6" />
          </button>
        </div>
        <nav className="flex flex-col gap-1 p-5">
          <Link
            href="/"
            className="rounded-lg px-3 py-2.5 text-[0.95rem] font-medium text-docs-text no-underline transition hover:bg-docs-accent-tint hover:text-docs-accent"
            onClick={onClose}
          >
            Home
          </Link>
          <Link
            href={basePath}
            className="rounded-lg px-3 py-2.5 text-[0.95rem] font-medium text-docs-text no-underline transition hover:bg-docs-accent-tint hover:text-docs-accent"
            onClick={onClose}
          >
            Docs
          </Link>
          <Link
            href={`${basePath}/tutorials/overview`}
            className="rounded-lg px-3 py-2.5 text-[0.95rem] font-medium text-docs-text no-underline transition hover:bg-docs-accent-tint hover:text-docs-accent"
            onClick={onClose}
          >
            Tutorials
          </Link>
          <a
            href="https://github.com/gurenjs/guren"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-[0.95rem] font-medium text-docs-text no-underline transition hover:bg-docs-accent-tint hover:text-docs-accent"
          >
            <GithubIcon className="size-4" />
            GitHub
          </a>
        </nav>
        {locales.length > 1 && (
          <div className="border-t border-docs-border px-5 py-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-docs-text-muted">Language</p>
            <div className="flex flex-wrap gap-1.5">
              {locales.map((locale) => (
                <Link
                  key={locale.code}
                  href={locale.href}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold no-underline transition ${
                    locale.active
                      ? 'bg-docs-accent-tint text-docs-accent'
                      : 'text-docs-text-muted hover:bg-docs-accent-tint hover:text-docs-accent'
                  }`}
                  onClick={onClose}
                >
                  {locale.label}
                </Link>
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}

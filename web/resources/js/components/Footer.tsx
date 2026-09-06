import { Link } from '@inertiajs/react'
import { GITHUB_URL } from '../../../config/site.js'
import { GithubIcon, RssIcon } from './icons.js'

interface FooterProps {
  variant: 'home' | 'docs'
}

export function Footer({ variant }: FooterProps) {
  const year = new Date().getFullYear()

  if (variant === 'docs') {
    return (
      <footer className="border-t border-docs-border bg-docs-page">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-4 px-6 py-6 text-sm text-docs-text-muted">
          <div className="flex items-center gap-3">
            <img src="/logo.svg" alt="Guren" className="size-6 rounded-md" />
            <span>&copy; {year} Guren Framework</span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/docs" className="no-underline transition hover:text-docs-accent">Docs</Link>
            <Link href="/blog" className="no-underline transition hover:text-docs-accent">Blog</Link>
            <a
              href="/blog/rss.xml"
              className="flex items-center gap-1.5 no-underline transition hover:text-docs-accent"
            >
              <RssIcon className="size-4" />
              RSS
            </a>
            <a
              href="https://github.com/gurenjs/guren"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 no-underline transition hover:text-docs-accent"
            >
              <GithubIcon className="size-4" />
              GitHub
            </a>
          </div>
        </div>
      </footer>
    )
  }

  return (
    <footer className="border-t border-white/10 bg-[#0a0707]">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-16 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="mb-4 flex items-center gap-3">
            <img src="/logo.svg" alt="Guren" className="size-9 rounded-xl p-0.5" />
            <span className="text-lg font-bold text-white">Guren</span>
          </div>
          <p className="text-sm leading-relaxed text-white/50">
            The fullstack TypeScript framework for the AI-agent era, built on Bun.
          </p>
        </div>
        <div>
          <h4 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/70">Resources</h4>
          <nav className="flex flex-col gap-2.5 text-sm text-white/50">
            <Link href="/docs" className="no-underline transition hover:text-white">Documentation</Link>
            <Link href="/docs/guides/getting-started" className="no-underline transition hover:text-white">Getting Started</Link>
            <Link href="/docs/tutorials/00-overview" className="no-underline transition hover:text-white">Tutorials</Link>
            <Link href="/blog" className="no-underline transition hover:text-white">Blog</Link>
            <a href="/blog/rss.xml" className="no-underline transition hover:text-white">RSS</a>
            <a href="/llms.txt" className="no-underline transition hover:text-white">llms.txt</a>
          </nav>
        </div>
        <div>
          <h4 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/70">Community</h4>
          <nav className="flex flex-col gap-2.5 text-sm text-white/50">
            <a href="https://github.com/gurenjs/guren" target="_blank" rel="noreferrer" className="no-underline transition hover:text-white">GitHub</a>
            <a href="https://github.com/gurenjs/guren/issues" target="_blank" rel="noreferrer" className="no-underline transition hover:text-white">Issues</a>
            <a href="https://github.com/gurenjs/guren/discussions" target="_blank" rel="noreferrer" className="no-underline transition hover:text-white">Discussions</a>
          </nav>
        </div>
        <div>
          <h4 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/70">Legal</h4>
          <nav className="flex flex-col gap-2.5 text-sm text-white/50">
            <a
              href={`${GITHUB_URL}/blob/main/LICENSE`}
              target="_blank"
              rel="noreferrer"
              className="no-underline transition hover:text-white"
            >
              MIT License
            </a>
          </nav>
        </div>
      </div>
      <div className="border-t border-white/10 px-6 py-5 text-center text-sm text-white/40">
        &copy; {year} Guren Framework &middot; MIT License
      </div>
    </footer>
  )
}

import { Link } from '@inertiajs/react'
import { GITHUB_URL, OWN_REPO_LINK_REL } from '../../../config/site.js'
import { GithubIcon, RssIcon } from './icons.js'

interface FooterProps {
  variant: 'home' | 'docs'
}

export function Footer({ variant }: FooterProps) {
  const year = new Date().getFullYear()

  if (variant === 'docs') {
    return (
      <footer className="border-t border-docs-border bg-docs-page">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-4 px-6 py-6 text-sm text-docs-text-secondary">
          <div className="flex items-center gap-3">
            <img src="/logo.svg" alt="" className="size-6 rounded-md" />
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
              rel={OWN_REPO_LINK_REL}
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
    <footer className="bg-home-ground font-home">
      <div className="mx-auto grid max-w-6xl gap-10 border-home-line px-6 py-16 sm:grid-cols-2 sm:px-10 lg:grid-cols-4 lg:border-x">
        <div>
          <div className="mb-4 flex items-center gap-3">
            <img src="/logo.svg" alt="" className="size-8 rounded-lg p-0.5" />
            <span className="text-[1.0625rem] font-bold text-home-text">Guren</span>
          </div>
          <p className="text-sm leading-relaxed text-home-text-2">
            The Bun-first fullstack TypeScript framework, built for coding agents.
          </p>
        </div>
        <div>
          <p className="mb-4 font-mono text-xs uppercase tracking-[0.14em] text-home-text-2">Resources</p>
          <nav aria-label="Resources" className="flex flex-col gap-2.5 text-sm text-home-text">
            <Link href="/docs" className="no-underline transition hover:text-crimson-300">Documentation</Link>
            <Link href="/docs/guides/getting-started" className="no-underline transition hover:text-crimson-300">Getting Started</Link>
            <Link href="/docs/tutorials/00-overview" className="no-underline transition hover:text-crimson-300">Tutorials</Link>
            <Link href="/docs/agent-course/00-overview" className="no-underline transition hover:text-crimson-300">Agent Course</Link>
            <Link href="/blog" className="no-underline transition hover:text-crimson-300">Blog</Link>
            <a href="/blog/rss.xml" className="no-underline transition hover:text-crimson-300">RSS</a>
            <a href="/llms.txt" className="no-underline transition hover:text-crimson-300">llms.txt</a>
          </nav>
        </div>
        <div>
          <p className="mb-4 font-mono text-xs uppercase tracking-[0.14em] text-home-text-2">Community</p>
          <nav aria-label="Community" className="flex flex-col gap-2.5 text-sm text-home-text">
            <a href="https://github.com/gurenjs/guren" target="_blank" rel={OWN_REPO_LINK_REL} className="no-underline transition hover:text-crimson-300">GitHub</a>
            <a href="https://github.com/gurenjs/guren/issues" target="_blank" rel={OWN_REPO_LINK_REL} className="no-underline transition hover:text-crimson-300">Issues</a>
            <a href="https://github.com/gurenjs/guren/discussions" target="_blank" rel={OWN_REPO_LINK_REL} className="no-underline transition hover:text-crimson-300">Discussions</a>
          </nav>
        </div>
        <div>
          <p className="mb-4 font-mono text-xs uppercase tracking-[0.14em] text-home-text-2">Legal</p>
          <nav aria-label="Legal" className="flex flex-col gap-2.5 text-sm text-home-text">
            <a
              href={`${GITHUB_URL}/blob/main/LICENSE`}
              target="_blank"
              rel={OWN_REPO_LINK_REL}
              className="no-underline transition hover:text-crimson-300"
            >
              MIT License
            </a>
          </nav>
        </div>
      </div>
      <div className="border-t border-home-line">
        <div className="mx-auto max-w-6xl border-home-line px-6 py-5 font-mono text-xs text-home-text-2 sm:px-10 lg:border-x">
          &copy; {year} Guren Framework &middot; MIT License
        </div>
      </div>
    </footer>
  )
}

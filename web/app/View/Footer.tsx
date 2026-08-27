/** @jsxImportSource @guren/core */
import type { FC } from '@guren/core'
import { GithubIcon, RssIcon } from './icons.js'

/**
 * Server-rendered port of the docs-variant `Footer` from
 * `resources/js/components/Footer.tsx` — same markup with plain `<a>` in
 * place of Inertia `<Link>`.
 */
export const Footer: FC = () => (
  <footer class="border-t border-docs-border bg-docs-page">
    <div class="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-4 px-6 py-6 text-sm text-docs-text-muted">
      <div class="flex items-center gap-3">
        <img src="/logo.svg" alt="Guren" class="size-6 rounded-md" />
        <span>&copy; {new Date().getFullYear()} Guren Framework</span>
      </div>
      <div class="flex items-center gap-4">
        <a href="/docs" class="no-underline transition hover:text-docs-accent">Docs</a>
        <a href="/blog" class="no-underline transition hover:text-docs-accent">Blog</a>
        <a href="/blog/rss.xml" class="flex items-center gap-1.5 no-underline transition hover:text-docs-accent">
          <RssIcon class="size-4" />
          RSS
        </a>
        <a
          href="https://github.com/gurenjs/guren"
          target="_blank"
          rel="noreferrer"
          class="flex items-center gap-1.5 no-underline transition hover:text-docs-accent"
        >
          <GithubIcon class="size-4" />
          GitHub
        </a>
      </div>
    </div>
  </footer>
)

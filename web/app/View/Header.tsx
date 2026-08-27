/** @jsxImportSource @guren/core */
import type { FC } from '@guren/core'
import { COLOR_MODE_TOGGLE_SCRIPT } from '../../config/document-theme.js'
import { GITHUB_URL } from '../../config/site.js'
import { GithubIcon, MenuIcon, MoonIcon, SunIcon } from './icons.js'

/**
 * Server-rendered port of the docs-variant `Header` from
 * `resources/js/components/Header.tsx`, for content pages that ship no
 * framework JS. The two client behaviors survive without one:
 *
 * - The color-mode toggle is `COLOR_MODE_TOGGLE_SCRIPT` from
 *   `config/document-theme.ts`, beside the prepaint script it must agree
 *   with (system-follow included; icon visibility is the `.cm-*` rules in
 *   `app.css`).
 * - The mobile menu is a `<details>` disclosure instead of React state.
 */

export const Header: FC = () => (
  <header class="sticky top-0 z-50 border-b border-docs-border bg-docs-page">
    <div class="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-4 px-6 py-3">
      <a href="/" class="flex items-center gap-3 text-docs-heading no-underline">
        <img src="/logo.svg" alt="Guren Docs" class="size-8 rounded-lg p-0.5" />
        <span class="text-[1.1rem] font-bold tracking-tight">Guren Docs</span>
      </a>
      <div class="flex flex-wrap items-center gap-5">
        <nav class="hidden items-center gap-6 text-[0.95rem] font-medium md:flex">
          <a href="/docs" class="text-docs-text no-underline transition hover:text-docs-accent">Guides</a>
          <a href="/docs/tutorials/overview" class="text-docs-text no-underline transition hover:text-docs-accent">Tutorials</a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            class="flex items-center gap-1.5 text-docs-text-muted no-underline transition hover:text-docs-accent"
          >
            <GithubIcon class="size-4" />
            GitHub
          </a>
        </nav>
        <button
          type="button"
          id="color-mode-toggle"
          class="text-docs-text-muted transition hover:text-docs-accent"
          aria-label="Switch color mode"
        >
          <SunIcon class="cm-sun size-5" />
          <MoonIcon class="cm-moon size-5" />
        </button>
        <details class="relative md:hidden">
          <summary
            class="flex cursor-pointer list-none items-center text-docs-text-muted transition hover:text-docs-accent [&::-webkit-details-marker]:hidden"
            aria-label="Menu"
          >
            <MenuIcon class="size-6" />
          </summary>
          <nav class="absolute right-0 mt-3 flex w-48 flex-col gap-1 rounded-xl border border-docs-border bg-docs-panel p-3 text-[0.95rem] font-medium shadow-lg">
            <a href="/" class="rounded-md px-3 py-2 text-docs-text no-underline transition hover:text-docs-accent">Home</a>
            <a href="/docs" class="rounded-md px-3 py-2 text-docs-text no-underline transition hover:text-docs-accent">Guides</a>
            <a href="/docs/tutorials/overview" class="rounded-md px-3 py-2 text-docs-text no-underline transition hover:text-docs-accent">Tutorials</a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              class="rounded-md px-3 py-2 text-docs-text-muted no-underline transition hover:text-docs-accent"
            >
              GitHub
            </a>
          </nav>
        </details>
      </div>
    </div>
    <script dangerouslySetInnerHTML={{ __html: COLOR_MODE_TOGGLE_SCRIPT }} />
  </header>
)

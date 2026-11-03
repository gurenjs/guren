import { Head, Link } from '@inertiajs/react'

import { pageTitle } from '../../../config/site.js'
import { Footer } from '../components/Footer.js'
import { Header } from '../components/Header.js'
import { BookOpenIcon, ChevronRightIcon, RssIcon, TerminalIcon } from '../components/icons.js'

interface Props {
  path: string
}

const DESTINATIONS = [
  { href: '/docs', label: 'Documentation', detail: 'Guides, the tutorial and the agent course', Icon: BookOpenIcon },
  { href: '/start', label: 'Start a new app', detail: 'Pick your options and copy the command', Icon: TerminalIcon },
  { href: '/blog', label: 'Blog', detail: 'Releases and benchmark reports', Icon: RssIcon },
]

/** Every URL no route answers. The docs keep their own not-found page, with the sidebar. */
export default function NotFound({ path }: Props) {
  return (
    <>
      <Head title={pageTitle('Page not found')}>
        <meta name="robots" content="noindex" />
      </Head>
      <div className="flex min-h-dvh flex-col bg-home-ground font-home text-home-text antialiased">
        <Header variant="home" />
        <main className="flex flex-1 items-center">
          <div className="mx-auto w-full max-w-3xl px-6 py-20 md:py-28">
            <p className="flex items-center gap-2.5 font-mono text-xs uppercase tracking-[0.14em] text-home-text-2">
              <span aria-hidden className="size-1.5 rounded-full bg-ember" />
              404 · not found
            </p>
            <h1 className="mt-5 text-balance text-[2.5rem] font-bold leading-[1.08] tracking-[-0.03em] md:text-[3.25rem]">
              Nothing lives at this address.
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-home-text-2">
              <code className="break-all rounded bg-home-raised px-1.5 py-0.5 font-mono text-[0.9em] text-home-text">
                {path}
              </code>{' '}
              is not a page on guren.dev. It may have moved, or the link may be mistyped.
            </p>
            <ul className="mt-10 grid gap-px overflow-hidden rounded-lg border border-home-line bg-home-line sm:grid-cols-3">
              {DESTINATIONS.map(({ href, label, detail, Icon }) => (
                <li key={href} className="bg-home-ground">
                  <Link
                    href={href}
                    className="group flex h-full flex-col p-5 transition hover:bg-home-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-crimson-300"
                  >
                    <Icon aria-hidden className="size-5 text-crimson-400" />
                    <span className="mt-4 font-bold">{label}</span>
                    <span className="mt-1 flex-1 text-sm leading-relaxed text-home-text-2">{detail}</span>
                    <ChevronRightIcon
                      aria-hidden
                      className="mt-4 size-4 text-home-text-2 transition group-hover:translate-x-0.5 group-hover:text-crimson-300"
                    />
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-8 text-sm text-home-text-2">
              Or go back to the{' '}
              <Link href="/" className="font-semibold text-crimson-300 underline decoration-crimson-300/40 underline-offset-4 transition hover:decoration-crimson-300">
                home page
              </Link>
              .
            </p>
          </div>
        </main>
        <Footer variant="home" />
      </div>
    </>
  )
}

import { Link } from '@inertiajs/react'
import { Fragment, useState, type ReactNode } from 'react'
interface Props {
  codeExamples: Record<string, string>
}
import { GITHUB_URL, OWN_REPO_LINK_REL, SITE_DESCRIPTION, SITE_TITLE } from '../../../config/site.js'
import { BurningName } from '../components/BurningName.js'
import { Footer } from '../components/Footer.js'
import { Header } from '../components/Header.js'
import { FunctionIcon, GithubIcon, GlobeIcon, LayersIcon, ServerIcon } from '../components/icons.js'
import { Seo } from '../components/Seo.js'
import { softwareJsonLd, websiteJsonLd } from '../lib/structured-data.js'

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.92em] text-crimson-300">{children}</code>
}

const features: Array<{ title: string; body: ReactNode }> = [
  {
    title: 'Controllers you already know',
    body: (
      <>
        <Code>validateBody()</Code> throws a 422, <Code>findOrFail()</Code> a 404,{' '}
        <Code>userOrFail()</Code> a 401.
      </>
    ),
  },
  {
    title: 'Types from route to React',
    body: 'Routes, page props and the API client are checked at compile time.',
  },
  {
    title: 'Drizzle models, Eloquent manners',
    body: (
      <>
        <Code>Post.where('published', true).get()</Code>, on top of Drizzle ORM.
      </>
    ),
  },
  {
    title: 'No API layer to babysit',
    body: 'Inertia passes controller props straight to React.',
  },
  {
    title: 'Batteries actually included',
    body: 'Auth, queues, mail, cache, events, scheduling, storage and i18n.',
  },
  {
    title: 'Prototype before the backend',
    body: 'Build the pages on fixtures, show them, then write the controllers.',
  },
]

const agentCommands = [
  { command: 'guren context User', detail: 'Everything about one entity' },
  { command: 'guren spec:generate', detail: 'ER, domain and screen views from code' },
  { command: 'guren check', detail: 'Wiring, doc links, spec drift' },
  { command: 'guren audit', detail: 'Validation, auth, secrets' },
]

const benchmarks = [
  { ratio: 2.3, label: 'SSR throughput' },
  { ratio: 3.5, label: 'JSON API throughput' },
  { ratio: 1.8, label: 'Faster cold starts' },
]

// Agents on Guren, 2026-08-18: 20 tasks × 3 models × {bare, shipped} × 3 trials.
// First two tiles are the Sonnet 5 column of results/RESULTS.md in
// gurenjs/agents-on-guren; the third counts all 180 runs per condition.
const agentBenchmarkStats = [
  { value: '−28%', label: 'turns with the harness (Sonnet 5, 60 runs each)' },
  { value: '−25%', label: 'cost, at 60/60 vs 58/60 runs passed' },
  { value: '119 vs 15', label: 'runs that ran guren check, harness vs bare (180 each)' },
]

const deployTargets = [
  {
    name: 'Bun server',
    Icon: ServerIcon,
    detail: 'Any VPS or container, on the runtime you develop on.',
    href: '/docs/guides/deployment',
    command: 'bunx guren deploy --target docker',
  },
  {
    name: 'Cloudflare Workers',
    Icon: GlobeIcon,
    detail: 'Workers and D1 at the edge. This site runs there.',
    href: '/docs/guides/cloudflare',
    command: 'bunx guren plugin @guren/plugin-cloudflare',
  },
  {
    name: 'Vercel',
    Icon: LayersIcon,
    detail: "Runs on Vercel's Bun runtime.",
    href: '/docs/guides/deployment#vercel-serverless',
    command: 'bunx guren plugin @guren/plugin-vercel',
  },
  {
    name: 'AWS Lambda',
    Icon: FunctionIcon,
    detail: 'A handler adapter with Node-compatible defaults.',
    href: '/docs/guides/serverless',
    command: 'bunx guren plugin @guren/plugin-lambda',
  },
]

const TAB_KEYS = ['Routes', 'Controller', 'Model', 'View'] as const
type TabKey = (typeof TAB_KEYS)[number]

const TAB_FILES: Record<TabKey, string> = {
  Routes: 'routes/web.ts',
  Controller: 'app/Http/Controllers/PostController.ts',
  Model: 'app/Models/Post.ts',
  View: 'resources/js/pages/posts/Index.tsx',
}

/** The logo's flame gradient cut to a short bar: the page's one structural mark. */
function Tick() {
  return <span aria-hidden className="block h-[3px] w-8 bg-gradient-to-r from-ember to-crimson-700" />
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mt-5 text-balance text-[2rem] font-bold leading-[1.1] tracking-[-0.025em] text-crimson-50 md:text-[2.5rem]">
      {children}
    </h2>
  )
}

function TextLink({ href, external, children }: { href: string; external?: boolean; children: ReactNode }) {
  const className =
    'font-semibold text-crimson-300 underline decoration-crimson-300/40 underline-offset-4 transition hover:decoration-crimson-300'
  return external ? (
    <a href={href} target="_blank" rel={OWN_REPO_LINK_REL} className={className}>
      {children}
    </a>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  )
}

const PRIMARY_BUTTON =
  'inline-flex items-center rounded-md bg-crimson-600 px-6 py-3 font-bold text-crimson-50 transition hover:bg-crimson-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crimson-300'

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable; the command is still selectable by hand.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="group inline-flex max-w-full items-center gap-2 rounded-md border border-white/15 bg-ink px-4 py-3 text-left font-mono text-[13px] text-crimson-50 transition hover:border-crimson-300/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crimson-300 sm:gap-3 sm:text-sm"
      aria-label={`Copy command: ${command}`}
    >
      <span className="select-none text-crimson-400">$</span>
      {/* Break between words only: the hyphens in create-guren-app are line-break opportunities. */}
      <span className="min-w-0">
        {command.split(' ').map((word, i) => (
          <Fragment key={i}>
            {i > 0 && ' '}
            <span className="whitespace-nowrap">{word}</span>
          </Fragment>
        ))}
      </span>
      <span className="select-none text-xs text-smoke/70 transition group-hover:text-smoke">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  )
}

function HeroName() {
  return (
    <figure aria-hidden className="hidden flex-col items-center lg:flex">
      <BurningName />
      <figcaption className="mt-6 text-sm text-smoke">gu·ren, crimson lotus</figcaption>
    </figure>
  )
}

export default function Home({ codeExamples }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('Routes')

  return (
    <>
      <Seo
        title={SITE_TITLE}
        description={SITE_DESCRIPTION.en}
        path="/"
        jsonLd={[websiteJsonLd(), softwareJsonLd()]}
      />
      <div className="min-h-dvh bg-crimson-950 font-home text-crimson-50 antialiased">
        <Header variant="home" />

        <section className="relative overflow-hidden border-b border-white/10">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(52%_70%_at_82%_40%,rgba(255,60,40,.22),transparent_72%)]"
          />
          <div className="relative mx-auto grid grid-cols-1 max-w-6xl gap-12 px-6 pb-20 pt-14 md:pb-28 md:pt-24 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-24">
            <div>
              <p className="flex items-baseline gap-3 text-sm text-smoke lg:hidden">
                <span lang="ja" className="font-mincho text-2xl font-bold text-crimson-400">
                  紅蓮
                </span>
                gu·ren, crimson lotus
              </p>
              <h1 className="mt-6 max-w-[19ch] text-balance text-[2.6rem] font-bold leading-[1.04] tracking-[-0.035em] text-crimson-50 sm:text-6xl lg:mt-0 lg:text-[4.5rem]">
                The <span className="whitespace-nowrap">Bun-first</span> fullstack TypeScript framework.
              </h1>
              <p className="mt-7 max-w-[36rem] text-lg leading-[1.65] text-smoke">
                Laravel-style conventions, types from the route to the React component, and checks
                your coding agent runs on its own work. Develop on Bun, deploy to Bun, AWS Lambda,
                Vercel or Cloudflare Workers.
              </p>
              <div className="mt-10 flex flex-wrap items-center gap-3">
                <Link href="/docs/guides/getting-started" className={PRIMARY_BUTTON}>
                  Get started
                </Link>
                <CopyCommand command="bunx create-guren-app my-app" />
              </div>
            </div>
            <HeroName />
          </div>
        </section>

        <section className="border-b border-white/10">
          <div className="mx-auto grid grid-cols-1 max-w-6xl gap-12 px-6 py-20 md:py-28 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
            <div>
              <Tick />
              <SectionHeading>Route to React, one loop</SectionHeading>
              <p className="mt-5 max-w-[34rem] text-[1.0625rem] leading-[1.65] text-smoke">
                A route points at a controller, and the controller&apos;s props reach the React
                component type-checked. There is no API client to write.
              </p>
              <div role="tablist" aria-label="Files in the loop" className="relative mt-10">
                <span aria-hidden className="absolute bottom-5 left-[5px] top-5 w-px bg-white/15" />
                {TAB_KEYS.map((tab) => {
                  const active = activeTab === tab
                  return (
                    <button
                      key={tab}
                      id={`loop-tab-${tab}`}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-controls="loop-panel"
                      onClick={() => setActiveTab(tab)}
                      className="group relative flex w-full items-start gap-4 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-crimson-300"
                    >
                      <span
                        aria-hidden
                        className={`relative mt-[7px] size-[11px] shrink-0 rounded-full border-2 transition ${
                          active ? 'border-ember bg-ember' : 'border-crimson-50/40 bg-crimson-950 group-hover:border-crimson-50/70'
                        }`}
                      />
                      <span className="min-w-0">
                        <span className={`block font-bold transition ${active ? 'text-crimson-50' : 'text-smoke group-hover:text-crimson-50'}`}>
                          {tab}
                        </span>
                        <span className={`block truncate font-mono text-xs transition ${active ? 'text-crimson-300' : 'text-smoke/70'}`}>
                          {TAB_FILES[tab]}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div
              id="loop-panel"
              role="tabpanel"
              aria-labelledby={`loop-tab-${activeTab}`}
              className="min-w-0 self-start overflow-hidden rounded-md border border-white/10 bg-ink"
            >
              <p className="border-b border-white/10 px-5 py-3 font-mono text-xs text-smoke">{TAB_FILES[activeTab]}</p>
              <div className="overflow-x-auto p-5 [font-variant-ligatures:none] [&_.shiki]:!m-0 [&_.shiki]:!rounded-none [&_.shiki]:!border-0 [&_.shiki]:!bg-transparent [&_.shiki]:!p-0 [&_.shiki]:!text-[12.5px] [&_.shiki]:!leading-[1.7]">
                <div dangerouslySetInnerHTML={{ __html: codeExamples[activeTab] ?? '' }} />
              </div>
            </div>
          </div>
        </section>

        <section className="border-b border-white/10">
          <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
            <div className="grid grid-cols-1 items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
              <div>
                <Tick />
                <SectionHeading>Built for AI coding agents</SectionHeading>
                <p className="mt-4 font-mono text-sm text-crimson-300">
                  derived where possible, declared where not, checked always
                </p>
                <p className="mt-5 max-w-[34rem] text-[1.0625rem] leading-[1.65] text-smoke">
                  Your agent reads what the project knows from the code itself, and CI fails when
                  the wiring, docs or spec drift.
                </p>
                <dl className="mt-8 border-b border-white/10">
                  {agentCommands.map((c) => (
                    <div key={c.command} className="grid grid-cols-1 gap-1 border-t border-white/10 py-3 sm:grid-cols-[12.5rem_1fr] sm:gap-4">
                      <dt className="font-mono text-sm text-crimson-50">
                        <span className="select-none text-smoke/60">$ </span>
                        {c.command}
                      </dt>
                      <dd className="text-sm text-smoke">{c.detail}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <figure>
                <a
                  href="/_guren/docs"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open the blog example's docs graph in the Guren docs viewer"
                  className="block overflow-hidden rounded-md border border-white/10 bg-ink p-1.5 transition hover:border-crimson-300/40"
                >
                  <img
                    src="/docs-graph.png"
                    alt="The Guren docs viewer rendering a blog app's knowledge graph: decision records, generated spec views, model entities, and source files connected by verified links"
                    width={1440}
                    height={900}
                    loading="lazy"
                    className="w-full rounded-[3px]"
                  />
                </a>
                <figcaption className="mt-4 text-sm leading-relaxed text-smoke">
                  The blog example&apos;s docs graph. Your app gets the same view at{' '}
                  <Code>/_guren/docs</Code>.
                </figcaption>
              </figure>
            </div>

            <div className="mt-16 grid grid-cols-1 gap-10 border-t border-white/10 pt-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
              <div>
                <p className="max-w-[34rem] text-[0.9375rem] leading-[1.65] text-smoke">
                  Measured on 360 runs of 20 tasks across three models, with and without the
                  harness.
                </p>
                <p className="mt-4 text-sm">
                  <TextLink href="https://github.com/gurenjs/agents-on-guren" external>
                    Benchmark report, tasks &amp; raw data
                  </TextLink>
                </p>
              </div>
              <dl className="grid grid-cols-1 gap-6 sm:grid-cols-3 sm:gap-0">
                {agentBenchmarkStats.map((s) => (
                  <div key={s.label} className="flex flex-col sm:border-l sm:border-white/10 sm:px-6 sm:first:border-l-0 sm:first:pl-0">
                    <dt className="order-2 mt-2 text-sm leading-snug text-smoke">{s.label}</dt>
                    <dd className="order-1 text-[2.75rem] font-bold leading-none tracking-[-0.03em] text-foam tabular-nums">
                      {s.value.split(' vs ').map((part, i) => (
                        <Fragment key={i}>
                          {i > 0 && <span className="mx-1.5 text-lg font-normal text-smoke">vs</span>}
                          {part}
                        </Fragment>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        <section className="border-b border-white/10">
          <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
            <Tick />
            <SectionHeading>Conventions you know. Types you didn&apos;t have.</SectionHeading>
            <div className="mt-14 grid grid-cols-1 gap-x-12 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((f) => (
                <div key={f.title} className="border-t border-white/10 pt-6">
                  <h3 className="text-lg font-bold leading-snug text-crimson-50">{f.title}</h3>
                  <p className="mt-3 text-[0.9375rem] leading-[1.65] text-smoke">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-white/10">
          <div className="mx-auto grid grid-cols-1 max-w-6xl gap-12 px-6 py-20 md:py-28 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
            <div>
              <Tick />
              <SectionHeading>Fast where it counts</SectionHeading>
              <p className="mt-5 max-w-[34rem] text-[1.0625rem] leading-[1.65] text-smoke">
                The same app on Guren and on a Node.js MVC framework, under identical conditions.
                The code is held constant, so the difference is Bun.
              </p>
              <p className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <TextLink href="https://github.com/gurenjs/framework-comparison/blob/main/BENCHMARK.md" external>
                  Methodology &amp; reproduction
                </TextLink>
                <TextLink href="/docs/guides/why-guren">Read the full comparison</TextLink>
              </p>
            </div>
            <div className="lg:pt-12">
              {benchmarks.map((b) => (
                <div
                  key={b.label}
                  className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-white/10 py-6 last:border-b sm:grid-cols-[6.5rem_1fr]"
                >
                  <p className="text-[2.75rem] font-bold leading-none tracking-[-0.03em] text-foam tabular-nums">
                    {b.ratio}
                    <span className="ml-0.5 text-[0.6em] font-normal">×</span>
                  </p>
                  <div>
                    <p className="font-bold text-crimson-50">{b.label}</p>
                    <div className="mt-4 space-y-1.5" aria-label={`Guren ${b.ratio}×, Node 1×`}>
                      <div className="flex items-center gap-3">
                        <span className="h-2 flex-1 rounded-r-sm bg-gradient-to-r from-crimson-700 to-ember" />
                        <span className="w-12 shrink-0 font-mono text-xs text-crimson-50">Guren</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="flex-1">
                          <span
                            className="block h-2 rounded-r-sm bg-crimson-50/25"
                            style={{ width: `${(100 / b.ratio).toFixed(2)}%` }}
                          />
                        </span>
                        <span className="w-12 shrink-0 font-mono text-xs text-smoke">Node</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-white/10">
          <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
            <Tick />
            <SectionHeading>Develop on Bun. Ship where you want.</SectionHeading>
            <p className="mt-5 max-w-[40rem] text-[1.0625rem] leading-[1.65] text-smoke">
              Pick a target, add its plugin, ship the same app.
            </p>
            <ul className="mt-12 border-b border-white/10">
              {deployTargets.map((t) => (
                <li key={t.name} className="border-t border-white/10">
                  <Link
                    href={t.href}
                    className="group grid grid-cols-1 gap-x-8 gap-y-1 py-5 transition hover:bg-white/[0.03] sm:grid-cols-[13rem_1fr_auto] sm:items-baseline sm:px-3"
                  >
                    <span className="flex items-center gap-3 font-bold text-crimson-50">
                      <t.Icon aria-hidden className="size-6 shrink-0 text-crimson-300" />
                      {t.name}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[0.9375rem] leading-relaxed text-smoke">{t.detail}</span>
                      <code className="mt-2 block truncate font-mono text-[13px] text-crimson-50">
                        <span className="select-none text-smoke/60">$ </span>
                        {t.command}
                      </code>
                    </span>
                    <span className="text-sm font-semibold text-smoke transition group-hover:text-crimson-300">
                      Guide
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_80%_at_20%_100%,rgba(255,60,40,.18),transparent_70%)]"
          />
          <div className="relative mx-auto grid grid-cols-1 max-w-6xl gap-14 px-6 py-24 md:py-32 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end lg:gap-20">
            <div>
              <h2 className="text-balance text-[2.25rem] font-bold leading-[1.08] tracking-[-0.03em] text-crimson-50 md:text-[3.25rem]">
                Your first app is one command away
              </h2>
              <p className="mt-5 text-lg text-smoke">
                Guren v2 is stable. New apps start on SQLite with nothing to set up.
              </p>
              <div className="mt-9">
                <CopyCommand command="bunx create-guren-app my-app" />
              </div>
              <div className="mt-5 flex flex-wrap gap-3">
                <Link href="/docs/guides/getting-started" className={PRIMARY_BUTTON}>
                  Read the quickstart
                </Link>
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel={OWN_REPO_LINK_REL}
                  className="inline-flex items-center gap-2 rounded-md border border-white/25 px-6 py-3 font-bold text-crimson-50 transition hover:border-white/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crimson-300"
                >
                  <GithubIcon className="size-4" />
                  View on GitHub
                </a>
              </div>
            </div>
            <aside className="border-l-2 border-crimson-700 pl-6 text-[0.9375rem] leading-[1.7] text-smoke">
              <p>
                <em className="font-bold not-italic text-crimson-50">Guren</em> (
                <span lang="ja" className="font-mincho text-crimson-300">
                  紅蓮
                </span>
) means &ldquo;crimson lotus&rdquo;: Laravel&apos;s conventions, re-grown in
                TypeScript. Same flower, different pond.
              </p>
            </aside>
          </div>
        </section>

        <Footer variant="home" />
      </div>
    </>
  )
}

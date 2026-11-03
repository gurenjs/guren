import { Link } from '@inertiajs/react'
import { Fragment, useState, type KeyboardEvent, type ReactNode } from 'react'
interface Props {
  codeExamples: Record<string, string>
}
import { GITHUB_URL, OWN_REPO_LINK_REL, SITE_DESCRIPTION, SITE_TITLE } from '../../../config/site.js'
import { BurningName } from '../components/BurningName.js'
import { ConventionGrid } from '../components/ConventionGrid.js'
import { CopyCommand } from '../components/CopyCommand.js'
import { Footer } from '../components/Footer.js'
import { Header } from '../components/Header.js'
import { ChevronRightIcon, FunctionIcon, GithubIcon, GlobeIcon, LayersIcon, ServerIcon } from '../components/icons.js'
import { InlineCode } from '../components/InlineCode.js'
import { Seo } from '../components/Seo.js'
import { TextLink } from '../components/TextLink.js'
import { Tick } from '../components/Tick.js'
import { softwareJsonLd, websiteJsonLd } from '../lib/structured-data.js'
import { tabAfterKey } from '../lib/tabs.js'

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
const agentBenchmarkStats: Array<{ value: string; versus?: string; label: string }> = [
  { value: '−28%', label: 'turns with the harness (Sonnet 5, 60 runs each)' },
  { value: '−25%', label: 'cost, at 60/60 vs 58/60 runs passed' },
  { value: '119', versus: '15', label: 'runs that ran guren check, harness vs bare (180 each)' },
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

const PRIMARY_BUTTON =
  'inline-flex items-center rounded-md bg-crimson-600 px-6 py-3 font-bold text-crimson-50 transition hover:bg-crimson-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crimson-300'

const SECONDARY_BUTTON =
  'inline-flex items-center gap-2 rounded-md border border-home-line-strong px-6 py-3 font-bold text-home-text transition hover:border-home-text-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crimson-300'

/** A plus mark where a section rule meets the frame's side rules. */
function FrameCross({ side }: { side: 'left' | 'right' }) {
  return (
    <span
      aria-hidden
      className={`absolute -bottom-[6px] z-10 hidden size-[11px] lg:block ${side === 'left' ? '-left-[6px]' : '-right-[6px]'}`}
    >
      <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-home-text-2" />
      <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-home-text-2" />
    </span>
  )
}

/**
 * One band of the page: a rule below it, and inside it the centred column whose
 * side rules run the full height of the page on wide screens.
 */
function Band({
  children,
  className = '',
  frameClassName = '',
  light = false,
}: {
  children: ReactNode
  className?: string
  frameClassName?: string
  light?: boolean
}) {
  return (
    <section className={`border-b ${light ? 'border-home-light-line bg-home-light text-home-light-text' : 'border-home-line'} ${className}`}>
      <div
        className={`relative mx-auto max-w-6xl lg:border-x ${light ? 'border-home-light-line' : 'border-home-line'} ${frameClassName}`}
      >
        <FrameCross side="left" />
        <FrameCross side="right" />
        {children}
      </div>
    </section>
  )
}

function SectionLabel({ children, light = false }: { children: ReactNode; light?: boolean }) {
  return (
    <p
      className={`flex items-center gap-3 font-mono text-xs uppercase tracking-[0.14em] ${light ? 'text-home-light-text-2' : 'text-home-text-2'}`}
    >
      <Tick />
      {children}
    </p>
  )
}

function SectionHeading({ children, light = false }: { children: ReactNode; light?: boolean }) {
  return (
    <h2
      className={`mt-5 text-balance text-[2rem] font-bold leading-[1.1] tracking-[-0.025em] md:text-[2.5rem] ${light ? 'text-home-light-text' : 'text-home-text'}`}
    >
      {children}
    </h2>
  )
}

function Lead({ children, light = false, center = false }: { children: ReactNode; light?: boolean; center?: boolean }) {
  return (
    <p
      className={`mt-5 max-w-[34rem] text-[1.0625rem] leading-[1.65] ${light ? 'text-home-light-text-2' : 'text-home-text-2'} ${center ? 'mx-auto' : ''}`}
    >
      {children}
    </p>
  )
}

function HeroName() {
  return (
    <figure aria-hidden className="relative flex flex-col items-center">
      <BurningName />
      <figcaption className="mt-6 font-mono text-xs uppercase tracking-[0.14em] text-home-text-2">
        gu·ren, crimson lotus
      </figcaption>
    </figure>
  )
}

function AgentTerminal() {
  return (
    <div className="mx-auto max-w-3xl overflow-hidden rounded-lg border border-home-line-strong bg-home-ink/95 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] backdrop-blur">
      <div className="flex items-center gap-2 border-b border-home-line px-4 py-3">
        <span aria-hidden className="size-2.5 rounded-full bg-home-line-strong" />
        <span aria-hidden className="size-2.5 rounded-full bg-home-line-strong" />
        <span aria-hidden className="size-2.5 rounded-full bg-home-line-strong" />
        <span className="ml-3 font-mono text-xs text-home-text-2">~/my-app</span>
      </div>
      <dl className="px-5 py-5 font-mono text-[13px] leading-[1.9] sm:px-6 sm:text-sm">
        {agentCommands.map((c) => (
          <div key={c.command} className="grid grid-cols-1 sm:grid-cols-[14rem_1fr] sm:gap-4">
            <dt className="text-home-text">
              <span className="select-none text-crimson-400">$ </span>
              {c.command}
            </dt>
            <dd className="text-home-text-2">
              <span className="select-none"># </span>
              {c.detail}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export default function Home({ codeExamples }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('Routes')

  // Arrow keys move between the tabs, as the ARIA tabs pattern expects.
  const moveTab = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = tabAfterKey(TAB_KEYS, activeTab, event.key)
    if (!next) return
    event.preventDefault()
    setActiveTab(next)
    document.getElementById(`loop-tab-${next}`)?.focus()
  }

  return (
    <>
      <Seo
        title={SITE_TITLE}
        description={SITE_DESCRIPTION.en}
        path="/"
        jsonLd={[websiteJsonLd(), softwareJsonLd()]}
      />
      <div className="min-h-dvh overflow-x-clip bg-home-ground font-home text-home-text antialiased">
        <Header variant="home" framed />

        <main>
          <Band frameClassName="grid grid-cols-1 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
            <div className="px-6 pb-16 pt-12 sm:px-10 md:pb-24 md:pt-20">
              <p className="flex items-center gap-2.5 font-mono text-xs uppercase tracking-[0.14em] text-home-text-2">
                <span aria-hidden className="size-1.5 rounded-full bg-ember" />
                v2 · stable · MIT
              </p>
              <p className="mt-5 flex items-baseline gap-3 text-sm text-home-text-2 lg:hidden">
                <span lang="ja" className="font-mincho text-2xl font-bold text-crimson-400">
                  紅蓮
                </span>
                gu·ren, crimson lotus
              </p>
              <h1 className="mt-6 max-w-[19ch] text-balance text-[2.6rem] font-bold leading-[1.04] tracking-[-0.035em] text-home-text sm:text-6xl lg:text-[4.25rem]">
                The <span className="whitespace-nowrap">Bun-first</span> fullstack TypeScript framework.
              </h1>
              <p className="mt-7 max-w-[34rem] text-lg leading-[1.65] text-home-text-2">
                Laravel-style conventions, types from the route to the React component, and checks
                your coding agent runs on its own work. Develop on Bun, deploy to Bun, AWS Lambda,
                Vercel or Cloudflare Workers.
              </p>
              <div className="mt-10 flex flex-wrap items-center gap-3">
                <Link href="/start" className={PRIMARY_BUTTON}>
                  Get started
                </Link>
                <a href={GITHUB_URL} target="_blank" rel={OWN_REPO_LINK_REL} className={SECONDARY_BUTTON}>
                  <GithubIcon className="size-4" />
                  View on GitHub
                </a>
              </div>
              <div className="mt-4">
                <CopyCommand command="bunx create-guren-app my-app" />
              </div>
            </div>
            <div className="relative hidden items-center justify-center overflow-hidden border-l border-home-line lg:flex">
              <div aria-hidden className="home-dots absolute inset-0" />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(45%_45%_at_50%_48%,rgba(255,60,40,.2),transparent_75%)]"
              />
              <HeroName />
            </div>
          </Band>

          <Band frameClassName="grid grid-cols-1 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
            <div className="px-6 py-16 sm:px-10 md:py-24">
              <SectionLabel>The loop</SectionLabel>
              <SectionHeading>Route to React, one loop</SectionHeading>
              <Lead>
                A route points at a controller, and the controller&apos;s props reach the React
                component type-checked. There is no API client to write.
              </Lead>
              <div role="tablist" aria-label="Files in the loop" onKeyDown={moveTab} className="relative mt-10">
                <span aria-hidden className="absolute bottom-5 left-[5px] top-5 w-px bg-home-line-strong" />
                {TAB_KEYS.map((tab) => {
                  const active = activeTab === tab
                  return (
                    <button
                      key={tab}
                      id={`loop-tab-${tab}`}
                      type="button"
                      role="tab"
                      tabIndex={active ? 0 : -1}
                      aria-selected={active}
                      aria-controls="loop-panel"
                      onClick={() => setActiveTab(tab)}
                      className="group relative flex w-full items-start gap-4 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-crimson-300"
                    >
                      <span
                        aria-hidden
                        className={`relative mt-[7px] size-[11px] shrink-0 rounded-full border-2 transition ${
                          active ? 'border-ember bg-ember' : 'border-home-text-2 bg-home-ground group-hover:border-home-text'
                        }`}
                      />
                      <span className="min-w-0">
                        <span className={`block font-bold transition ${active ? 'text-home-text' : 'text-home-text-2 group-hover:text-home-text'}`}>
                          {tab}
                        </span>
                        <span className={`block truncate font-mono text-xs transition ${active ? 'text-crimson-300' : 'text-home-text-2'}`}>
                          {TAB_FILES[tab]}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="min-w-0 border-home-line px-6 pb-16 sm:px-10 lg:border-l lg:py-24">
              <div
                id="loop-panel"
                role="tabpanel"
                aria-labelledby={`loop-tab-${activeTab}`}
                className="min-w-0 overflow-hidden rounded-lg border border-home-line-strong bg-home-ink"
              >
                <p className="flex items-center gap-2 border-b border-home-line px-5 py-3 font-mono text-xs text-home-text-2">
                  <span aria-hidden className="size-1.5 rounded-full bg-ember" />
                  {TAB_FILES[activeTab]}
                </p>
                <div className="overflow-x-auto p-5 text-[12.5px] leading-[1.7] [font-variant-ligatures:none] [&_.shiki]:!bg-transparent">
                  <div dangerouslySetInnerHTML={{ __html: codeExamples[activeTab] ?? '' }} />
                </div>
              </div>
            </div>
          </Band>

          <Band>
            <div className="px-6 pt-16 text-center sm:px-10 md:pt-24">
              <div className="flex justify-center">
                <SectionLabel>For coding agents</SectionLabel>
              </div>
              <SectionHeading>Built for AI coding agents</SectionHeading>
              <p className="mt-4 font-mono text-sm text-crimson-300">
                derived where possible, declared where not, checked always
              </p>
              <Lead center>
                Your agent reads what the project knows from the code itself, and CI fails when
                the wiring, docs or spec drift.
              </Lead>
            </div>
            <div className="relative mt-12 px-6 pb-16 sm:px-10 md:pb-20">
              <div aria-hidden className="home-burst pointer-events-none absolute inset-0" />
              <div className="relative">
                <AgentTerminal />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-px border-t border-home-line bg-home-line sm:grid-cols-2 lg:grid-cols-4">
              <div className="bg-home-ground px-6 py-8 sm:px-8">
                <p className="text-[0.9375rem] leading-[1.65] text-home-text-2">
                  Measured on 360 runs of 20 tasks across three models, with and without the
                  harness.
                </p>
                <p className="mt-4 text-sm">
                  <TextLink href="https://github.com/gurenjs/agents-on-guren" external>
                    Benchmark report, tasks &amp; raw data
                  </TextLink>
                </p>
              </div>
              {agentBenchmarkStats.map((s) => (
                <dl key={s.label} className="flex flex-col bg-home-ground px-6 py-8 sm:px-8">
                  <dt className="order-2 mt-3 text-sm leading-snug text-home-text-2">{s.label}</dt>
                  <dd className="order-1 text-[2.75rem] font-bold leading-none tracking-[-0.03em] text-foam tabular-nums">
                    {s.value}
                    {s.versus && (
                      <>
                        <span className="mx-1.5 text-lg font-normal text-home-text-2">vs</span>
                        {s.versus}
                      </>
                    )}
                  </dd>
                </dl>
              ))}
            </div>
            <figure className="grid grid-cols-1 items-center gap-8 border-t border-home-line px-6 py-12 sm:px-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-14">
              <figcaption className="text-[0.9375rem] leading-relaxed text-home-text-2">
                The blog example&apos;s docs graph. Your app gets the same view at{' '}
                <InlineCode>/_guren/docs</InlineCode>.
              </figcaption>
              <a
                href="/_guren/docs"
                target="_blank"
                rel="noreferrer"
                aria-label="Open the blog example's docs graph in the Guren docs viewer"
                className="block overflow-hidden rounded-lg border border-home-line-strong bg-home-ink p-1.5 transition hover:border-crimson-300/40"
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
            </figure>
          </Band>

          <Band>
            <div className="px-6 pb-12 pt-16 sm:px-10 md:pt-24">
              <SectionLabel>Conventions</SectionLabel>
              <SectionHeading>Conventions you know. Types you didn&apos;t have.</SectionHeading>
            </div>
            <ConventionGrid />
          </Band>

          <Band frameClassName="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div className="px-6 py-16 sm:px-10 md:py-24">
              <SectionLabel>Performance</SectionLabel>
              <SectionHeading>Fast where it counts</SectionHeading>
              <Lead>
                The same app on Guren and on a Node.js MVC framework, under identical conditions.
                The code is held constant, so the difference is Bun.
              </Lead>
              <p className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <TextLink href="https://github.com/gurenjs/framework-comparison/blob/main/BENCHMARK.md" external>
                  Methodology &amp; reproduction
                </TextLink>
                <TextLink href="/docs/guides/why-guren">Read the full comparison</TextLink>
              </p>
            </div>
            <div className="border-home-line lg:border-l">
              {benchmarks.map((b) => (
                <div
                  key={b.label}
                  className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-home-line px-6 py-8 sm:grid-cols-[6.5rem_1fr] sm:px-10 lg:first:border-t-0 lg:py-10"
                >
                  <p className="text-[2.75rem] font-bold leading-none tracking-[-0.03em] text-foam tabular-nums">
                    {b.ratio}
                    <span className="ml-0.5 text-[0.6em] font-normal">×</span>
                  </p>
                  <div>
                    <p className="font-bold text-home-text">{b.label}</p>
                    <div aria-hidden className="mt-4 space-y-1.5">
                      <div className="flex items-center gap-3">
                        <span className="h-2 flex-1 rounded-r-sm bg-gradient-to-r from-crimson-700 to-ember" />
                        <span className="w-12 shrink-0 font-mono text-xs text-home-text">Guren</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="flex-1">
                          <span
                            className="block h-2 rounded-r-sm bg-home-line-strong"
                            style={{ width: `${(100 / b.ratio).toFixed(2)}%` }}
                          />
                        </span>
                        <span className="w-12 shrink-0 font-mono text-xs text-home-text-2">Node</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Band>

          <Band light>
            <div className="px-6 pb-12 pt-16 text-center sm:px-10 md:pt-24">
              <div className="flex justify-center">
                <SectionLabel light>Deploy</SectionLabel>
              </div>
              <SectionHeading light>Develop on Bun. Ship where you want.</SectionHeading>
              <Lead light center>
                Pick a target, add its plugin, ship the same app.
              </Lead>
            </div>
            <ul className="grid grid-cols-1 gap-px border-t border-home-light-line bg-home-light-line sm:grid-cols-2 lg:grid-cols-4">
              {deployTargets.map((t) => (
                <li key={t.name} className="bg-home-light">
                  <Link
                    href={t.href}
                    className="group flex h-full flex-col px-6 py-8 transition hover:bg-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-crimson-700 sm:px-8"
                  >
                    <t.Icon aria-hidden className="size-7 text-crimson-700" />
                    <span className="mt-5 font-bold text-home-light-text">{t.name}</span>
                    <span className="mt-2 flex-1 text-[0.9375rem] leading-relaxed text-home-light-text-2">{t.detail}</span>
                    <code className="mt-5 block rounded-md border border-home-light-line bg-white px-3 py-2 font-mono text-[12px] leading-relaxed text-home-light-text">
                      <span className="select-none text-crimson-700">$ </span>
                      {/* Break between words only: a flag's hyphens are line-break opportunities. */}
                      {t.command.split(' ').map((word, i) => (
                        <Fragment key={i}>
                          {i > 0 && ' '}
                          <span className="whitespace-nowrap">{word}</span>
                        </Fragment>
                      ))}
                    </code>
                    <span className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-home-light-text-2 transition group-hover:text-crimson-700">
                      Guide
                      <ChevronRightIcon aria-hidden className="size-3.5" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Band>

          <Band className="relative">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_70%_at_50%_100%,rgba(255,60,40,.18),transparent_70%)]"
            />
            <div className="relative px-6 py-20 text-center sm:px-10 md:py-28">
              <h2 className="mx-auto max-w-[22ch] text-balance text-[2.25rem] font-bold leading-[1.08] tracking-[-0.03em] text-home-text md:text-[3.25rem]">
                Your first app is one command away
              </h2>
              <p className="mt-5 text-lg text-home-text-2">
                Guren v2 is stable. New apps start on SQLite with nothing to set up.
              </p>
              <div className="mt-9 flex justify-center">
                <CopyCommand command="bunx create-guren-app my-app" />
              </div>
              <p className="mt-4 text-[0.9375rem] text-home-text-2">
                Postgres, an API-only app, or a coding agent to set it up?{' '}
                <TextLink href="/start">Pick your options</TextLink> and copy the command or the prompt.
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <Link href="/docs/guides/getting-started" className={PRIMARY_BUTTON}>
                  Read the quickstart
                </Link>
                <a href={GITHUB_URL} target="_blank" rel={OWN_REPO_LINK_REL} className={SECONDARY_BUTTON}>
                  <GithubIcon className="size-4" />
                  View on GitHub
                </a>
              </div>
              <p className="mx-auto mt-14 max-w-[36rem] text-[0.9375rem] leading-[1.7] text-home-text-2">
                <em className="font-bold not-italic text-home-text">Guren</em> (
                <span lang="ja" className="font-mincho text-crimson-300">
                  紅蓮
                </span>
  ) means &ldquo;crimson lotus&rdquo;: Laravel&apos;s conventions, re-grown in
                TypeScript. Same flower, different pond.
              </p>
            </div>
          </Band>
        </main>

        <Footer variant="home" />
      </div>
    </>
  )
}

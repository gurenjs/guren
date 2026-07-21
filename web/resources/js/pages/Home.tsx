import { Link } from '@inertiajs/react'
import { useState } from 'react'
interface Props {
  codeExamples: Record<string, string>
}
import { GITHUB_URL, SITE_DESCRIPTION, SITE_TITLE } from '../../../config/site.js'
import { CodeBlock } from '../components/CodeBlock.js'
import { FeatureCard } from '../components/FeatureCard.js'
import { Footer } from '../components/Footer.js'
import { Header } from '../components/Header.js'
import { Seo } from '../components/Seo.js'
import { softwareJsonLd, websiteJsonLd } from '../lib/structured-data.js'
import {
  ArrowRightIcon,
  BoltIcon,
  BookOpenIcon,
  CodeBracketIcon,
  CubeIcon,
  RocketIcon,
  ShieldCheckIcon,
  TerminalIcon,
} from '../components/icons.js'

const features = [
  {
    icon: <BookOpenIcon className="size-5" />,
    title: 'Controllers you already know',
    body: 'validateBody() throws a 422, findOrFail() a 404, auth.userOrFail() a 401. Write the happy path — the framework answers for the rest.',
  },
  {
    icon: <ShieldCheckIcon className="size-5" />,
    title: 'Types from route to React',
    body: 'Codegen turns routes, page props, and the API client into compile-time contracts. Rename a route and the build fails — not your users.',
  },
  {
    icon: <CubeIcon className="size-5" />,
    title: 'Drizzle models, Eloquent manners',
    body: "Post.where('published', true).get() rides on Drizzle ORM. Models when you want conventions, raw SQL when you don't.",
  },
  {
    icon: <BoltIcon className="size-5" />,
    title: 'No API layer to babysit',
    body: 'Inertia.js hands controller props straight to your React components. One repo, one deploy, zero REST/GraphQL glue.',
  },
  {
    icon: <RocketIcon className="size-5" />,
    title: 'Batteries actually included',
    body: 'Auth, queues, mail, cache, events, scheduling, storage, i18n — first-party subsystems, not a shopping list of npm packages.',
  },
  {
    icon: <TerminalIcon className="size-5" />,
    title: 'Built for AI agents too',
    body: 'guren context maps your app, guren check verifies route–controller–page wiring, guren audit gates security. Your agent reads the same docs you do — every page is served as Markdown.',
  },
]

interface BenchmarkBar {
  name: string
  ratio: number
  display: string
  accent: boolean
}

interface Benchmark {
  value: string
  label: string
  detail: string
  bars: BenchmarkBar[]
}

const benchmarks: Benchmark[] = [
  {
    value: '2.3×',
    label: 'SSR throughput',
    detail: 'Full Inertia SSR pages, same app on a Node.js MVC framework',
    bars: [
      { name: 'Guren', ratio: 2.3, display: '2.3×', accent: true },
      { name: 'Node', ratio: 1, display: '1×', accent: false },
    ],
  },
  {
    value: '3.5×',
    label: 'JSON API throughput',
    detail: 'The plain JSON path, same-app comparison',
    bars: [
      { name: 'Guren', ratio: 3.5, display: '3.5×', accent: true },
      { name: 'Node', ratio: 1, display: '1×', accent: false },
    ],
  },
  {
    value: '1.8×',
    label: 'Faster cold starts',
    detail: 'Process start to first response',
    bars: [
      { name: 'Guren', ratio: 1.8, display: '1.8×', accent: true },
      { name: 'Node', ratio: 1, display: '1×', accent: false },
    ],
  },
]

const agentCostSteps = [
  { name: 'Bare repo', cost: 5.54, display: '$5.54', accent: false },
  { name: 'Big CLAUDE.md', cost: 4.51, display: '$4.51', accent: false },
  { name: 'Shipped guidance', cost: 3.35, display: '$3.35', accent: true },
]

const TAB_KEYS = ['Routes', 'Controller', 'Model'] as const
type TabKey = (typeof TAB_KEYS)[number]

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable — the command is still visible to select by hand.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="group inline-flex items-center gap-3 rounded-lg border border-white/15 bg-black/40 px-5 py-3 font-mono text-sm text-white/90 transition hover:border-crimson-400/60"
      aria-label={`Copy command: ${command}`}
    >
      <span className="select-none text-crimson-400">$</span>
      {command}
      <span className="select-none text-xs text-white/40 transition group-hover:text-white/70">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
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
      <div className="min-h-dvh bg-[radial-gradient(circle_at_10%_20%,rgba(255,190,190,.25),transparent_55%),radial-gradient(circle_at_85%_15%,rgba(183,28,28,.12),transparent_45%),#0f0a0a] text-crimson-50">
        <Header variant="home" />

        {/* Hero */}
        <section className="relative overflow-hidden px-6 py-20 md:py-32">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-32 -top-32 h-[500px] w-[500px] rounded-full bg-[radial-gradient(circle,rgba(183,28,28,.2),transparent_65%)]"
          />
          {/* 紅蓮 — the framework's namesake, set vertically like a hanging scroll */}
          <span
            aria-hidden
            className="pointer-events-none absolute right-[6%] top-1/2 hidden h-[23rem] -translate-y-1/2 select-none text-[10rem] font-bold leading-none text-crimson-500/[0.09] lg:block"
            style={{ writingMode: 'vertical-rl', fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif' }}
          >
            紅蓮
          </span>
          <div className="relative mx-auto max-w-5xl">
            <p className="text-sm font-medium tracking-wide text-crimson-300">
              <span style={{ fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif' }}>紅蓮</span>
              <span className="mx-2 text-crimson-300/50">·</span>
              <span className="font-mono">/gu·ren/</span>
              <span className="mx-2 text-crimson-300/50">·</span>
              crimson lotus
            </p>
            <h1 className="mt-5 text-4xl font-extrabold leading-[1.1] tracking-tight text-white sm:text-5xl md:text-6xl">
              The{' '}
              <span className="bg-gradient-to-r from-crimson-400 to-crimson-600 bg-clip-text text-transparent">
                Laravel feeling
              </span>
              , at Bun speed.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-white/70 md:text-xl">
              Guren is a fullstack framework for Bun. Controllers, models, queues, mail — the
              conventions you know from Laravel, with type safety that runs from the route
              definition to the React component. And your AI agent gets the same map you do,
              shipped with every new app.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-4">
              <Link
                href="/docs/guides/getting-started"
                className="inline-flex items-center gap-2 rounded-full bg-crimson-500 px-8 py-3.5 font-semibold text-white shadow-lg shadow-crimson-500/30 transition hover:-translate-y-0.5 hover:bg-crimson-600 hover:shadow-xl hover:shadow-crimson-500/40"
              >
                Get started
                <ArrowRightIcon className="size-4" />
              </Link>
              <CopyCommand command="bunx create-guren-app my-app" />
            </div>
          </div>
        </section>

        {/* Code Showcase */}
        <section className="px-6 py-20">
          <div className="mx-auto grid max-w-5xl items-start gap-12 lg:grid-cols-2">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.3em] text-crimson-400">The shape of a Guren app</p>
              <h2 className="mt-3 text-3xl font-bold text-white md:text-4xl">
                Three files, <br className="hidden sm:block" />one feature
              </h2>
              <p className="mt-4 text-base leading-relaxed text-white/60">
                A route points at a controller. The controller validates input, queries a model,
                and returns a typed Inertia page. That&apos;s the whole loop — no serializers, no
                resolvers, no hand-written API client.
              </p>
              <CodeBlock
                lines={[
                  '$ bunx create-guren-app my-app',
                  '$ cd my-app',
                  '$ bun run dev',
                ]}
                title="Terminal"
              />
            </div>
            <div className="rounded-xl border border-white/10 bg-[#1a1212]">
              <div className="flex border-b border-white/10">
                {TAB_KEYS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    className={`px-5 py-3 text-sm font-medium transition ${
                      activeTab === tab
                        ? 'border-b-2 border-crimson-500 text-crimson-300'
                        : 'text-white/50 hover:text-white/80'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <div className="overflow-x-auto p-5 [&_.shiki]:!border-0 [&_.shiki]:!bg-transparent [&_.shiki]:!p-0 [&_.shiki]:!m-0">
                <div dangerouslySetInnerHTML={{ __html: codeExamples[activeTab] ?? '' }} />
              </div>
            </div>
          </div>
        </section>

        {/* Feature Grid */}
        <section className="px-6 py-20">
          <div className="mx-auto max-w-5xl">
            <div className="mb-12 text-center">
              <p className="text-sm font-semibold uppercase tracking-[0.3em] text-crimson-400">Why Guren</p>
              <h2 className="mt-3 text-3xl font-bold text-white md:text-4xl">
                Conventions you know. Types you didn&apos;t have.
              </h2>
            </div>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((f) => (
                <FeatureCard key={f.title} icon={f.icon} title={f.title} body={f.body} />
              ))}
            </div>
          </div>
        </section>

        {/* Agent Evaluation */}
        <section className="border-t border-white/10 px-6 py-20">
          <div className="mx-auto grid max-w-5xl items-start gap-12 lg:grid-cols-2">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.3em] text-crimson-400">Agent-native</p>
              <h2 className="mt-3 text-3xl font-bold text-white md:text-4xl">
                Built for AI coding agents
              </h2>
              <p className="mt-4 text-base leading-relaxed text-white/60">
                One command hands an agent your whole project map. Three mechanical gates catch its
                mistakes before you read the diff. And every new app ships a full agent harness —
                CLAUDE.md, path-scoped rules, skills, and hooks — whose effect is measured in a
                public, reproducible evaluation: a 40% cut in agent cost over an undocumented
                baseline.
              </p>
              <CodeBlock
                lines={[
                  '$ bunx guren context    # project map for the agent',
                  '$ bunx guren check      # routes ↔ controllers ↔ pages',
                  '$ bunx guren audit      # validation, auth, secrets',
                  '$ bunx guren agent:sync # refresh CLAUDE.md & rules',
                ]}
                title="Terminal"
              />
              <p className="mt-4 text-sm leading-relaxed text-white/50">
                Every Guren trial in the evaluation shipped a working feature — scored blind by
                typecheck, tests, and a hidden HTTP smoke the agent never saw.
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6">
              <p className="text-sm font-semibold text-white">
                Agent cost for the same feature
              </p>
              <p className="mt-1 text-xs text-white/50">
                Median USD per trial — Claude Code building a full tagging feature on Guren
              </p>
              <div className="mt-6 space-y-4">
                {agentCostSteps.map((step) => (
                  <div key={step.name} title={`${step.name}: ${step.display}`}>
                    <p className="text-[11px] font-medium text-white/60">{step.name}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <div
                        className={`h-3 shrink-0 rounded-r ${step.accent ? 'bg-crimson-500' : 'bg-[#6b6363]'}`}
                        style={{ width: `calc((100% - 48px) * ${(step.cost / 5.54).toFixed(4)})` }}
                      />
                      <span className="shrink-0 text-[11px] text-white/70">{step.display}</span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-5 text-xs leading-relaxed text-white/50">
                The guidance in the last bar — a lean auto-loaded CLAUDE.md plus path-scoped rules —
                is exactly what <code className="text-white/70">create-guren-app</code> ships today.
              </p>
              <a
                href="https://github.com/gurenjs/framework-comparison/tree/main/agent-eval"
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-crimson-300 transition hover:text-crimson-200"
              >
                Evaluation harness &amp; raw data
                <ArrowRightIcon className="size-3.5" />
              </a>
            </div>
          </div>
        </section>

        {/* Benchmarks */}
        <section className="border-t border-white/10 px-6 py-20">
          <div className="mx-auto max-w-5xl">
            <div className="mb-12 text-center">
              <p className="text-sm font-semibold uppercase tracking-[0.3em] text-crimson-400">Measured, not promised</p>
              <h2 className="mt-3 text-3xl font-bold text-white md:text-4xl">
                Fast where it counts
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-white/60">
                The same spec app on Guren and on the equivalent Node.js MVC stack, benchmarked
                under identical conditions. The app code is held constant, so the gap is Bun itself —
                and that is the point: keep the Laravel-style architecture, change the engine.
                Every number is reproducible with one command.
              </p>
            </div>
            <div className="grid gap-5 sm:grid-cols-3">
              {benchmarks.map((b) => {
                const maxRatio = Math.max(...b.bars.map((bar) => bar.ratio))
                return (
                  <div
                    key={b.label}
                    className="rounded-xl border border-white/10 bg-white/[0.03] p-6"
                  >
                    <p className="bg-gradient-to-r from-crimson-300 to-crimson-500 bg-clip-text text-center text-4xl font-extrabold text-transparent">
                      {b.value}
                    </p>
                    <p className="mt-2 text-center text-sm font-semibold text-white">{b.label}</p>
                    <div className="mt-4 space-y-1.5">
                      {b.bars.map((bar) => (
                        <div key={bar.name} className="flex items-center gap-2" title={`${bar.name}: ${bar.display}`}>
                          <span className="w-11 shrink-0 text-[10px] font-medium text-white/50">
                            {bar.name}
                          </span>
                          <div className="flex flex-1 items-center gap-1.5">
                            <div
                              className={`h-2.5 shrink-0 rounded-r ${bar.accent ? 'bg-crimson-500' : 'bg-[#6b6363]'}`}
                              style={{ width: `calc((100% - 34px) * ${(bar.ratio / maxRatio).toFixed(4)})` }}
                            />
                            <span className="shrink-0 text-[10px] text-white/70">{bar.display}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="mt-3 text-center text-xs leading-relaxed text-white/50">{b.detail}</p>
                  </div>
                )
              })}
            </div>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm">
              <a
                href="https://github.com/gurenjs/framework-comparison/blob/main/BENCHMARK.md"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 font-semibold text-crimson-300 transition hover:text-crimson-200"
              >
                Methodology &amp; reproduction
                <ArrowRightIcon className="size-3.5" />
              </a>
              <Link
                href="/docs/guides/why-guren"
                className="inline-flex items-center gap-1.5 font-semibold text-crimson-300 transition hover:text-crimson-200"
              >
                Read the full comparison
                <ArrowRightIcon className="size-3.5" />
              </Link>
            </div>
          </div>
        </section>

        {/* Name origin */}
        <section className="border-y border-white/10 bg-white/[0.02] px-6 py-14">
          <div className="mx-auto flex max-w-4xl flex-col items-center gap-6 text-center md:flex-row md:gap-10 md:text-left">
            <span
              className="h-40 select-none text-7xl font-bold leading-none text-crimson-400/80"
              style={{ writingMode: 'vertical-rl', fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif' }}
              lang="ja"
            >
              紅蓮
            </span>
            <div>
              <p className="text-lg leading-relaxed text-white/80">
                <em className="font-semibold not-italic text-white">Guren</em> (紅蓮) is Japanese for
                &ldquo;crimson lotus&rdquo; — the color of a blazing flame.
              </p>
              <p className="mt-3 text-base leading-relaxed text-white/55">
                It is also a nod to where the framework comes from: Laravel&apos;s conventions,
                re-grown in TypeScript soil. Same flower, different pond.
              </p>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="relative overflow-hidden px-6 py-24">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(183,28,28,.15),transparent_70%)]"
          />
          <div className="relative mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold text-white md:text-4xl">
              Your first app is one command away
            </h2>
            <p className="mt-4 text-lg text-white/60">
              Guren is stable at v1.0. SQLite by default — no Docker, no config, no boilerplate.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <CopyCommand command="bunx create-guren-app my-app" />
            </div>
            <div className="mt-6 flex flex-wrap justify-center gap-4">
              <Link
                href="/docs/guides/getting-started"
                className="inline-flex items-center gap-2 rounded-full bg-crimson-500 px-8 py-3.5 font-semibold text-white shadow-lg shadow-crimson-500/30 transition hover:-translate-y-0.5 hover:bg-crimson-600"
              >
                Read the quickstart
                <ArrowRightIcon className="size-4" />
              </Link>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-white/30 px-8 py-3.5 font-semibold text-white/90 transition hover:border-white/50 hover:text-white"
              >
                <CodeBracketIcon className="size-4" />
                View on GitHub
              </a>
            </div>
          </div>
        </section>

        <Footer variant="home" />
      </div>
    </>
  )
}

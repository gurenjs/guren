import { Head, Link } from '@inertiajs/react'
import { useState } from 'react'
interface Props {
  message: string
  codeExamples: Record<string, string>
}
import { CodeBlock } from '../components/CodeBlock.js'
import { FeatureCard } from '../components/FeatureCard.js'
import { Footer } from '../components/Footer.js'
import { Header } from '../components/Header.js'
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
    icon: <BoltIcon className="size-5" />,
    title: 'Instant DX',
    body: 'Hot reload Bun server + Vite + Inertia keeps backend and frontend edits perfectly in sync.',
  },
  {
    icon: <ShieldCheckIcon className="size-5" />,
    title: 'Type-safe Stack',
    body: 'Drizzle ORM powers eloquent-style models with full TypeScript inference out of the box.',
  },
  {
    icon: <TerminalIcon className="size-5" />,
    title: 'CLI Toolkit',
    body: 'Generators, route typing, and runtime helpers live under one `guren` command.',
  },
  {
    icon: <BookOpenIcon className="size-5" />,
    title: 'Laravel-inspired',
    body: 'Controllers, middleware, routing, validation — all the patterns you love, in TypeScript.',
  },
  {
    icon: <CubeIcon className="size-5" />,
    title: 'Inertia.js',
    body: 'Build modern SPAs without building an API. Server-side routing with React views.',
  },
  {
    icon: <RocketIcon className="size-5" />,
    title: 'Built on Bun',
    body: "Leverage Bun's fast runtime, native TypeScript, and built-in package manager.",
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

export default function Home({ message, codeExamples }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('Routes')

  return (
    <>
      <Head title="Guren — Laravel-inspired TypeScript Framework for Bun" />
      <div className="min-h-dvh bg-[radial-gradient(circle_at_10%_20%,rgba(255,190,190,.25),transparent_55%),radial-gradient(circle_at_85%_15%,rgba(183,28,28,.12),transparent_45%),#0f0a0a] text-crimson-50">
        <Header variant="home" />

        {/* Hero */}
        <section className="relative overflow-hidden px-6 py-20 md:py-32">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-32 -top-32 h-[500px] w-[500px] rounded-full bg-[radial-gradient(circle,rgba(183,28,28,.2),transparent_65%)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -left-32 bottom-0 h-[400px] w-[400px] rounded-full bg-[radial-gradient(circle,rgba(255,190,190,.1),transparent_65%)]"
          />
          <div className="relative mx-auto max-w-5xl animate-fade-in-up">
            <p className="text-sm font-semibold uppercase tracking-[0.35em] text-crimson-300">
              Bun-native MVC Framework
            </p>
            <h1 className="mt-5 text-4xl font-extrabold leading-[1.1] tracking-tight text-white sm:text-5xl md:text-6xl">
              {message.split('Guren').length > 1 ? (
                <>
                  {message.split('Guren')[0]}
                  <span className="bg-gradient-to-r from-crimson-400 to-crimson-600 bg-clip-text text-transparent">Guren</span>
                  {message.split('Guren')[1]}
                </>
              ) : (
                message
              )}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-white/70 md:text-xl">
              Bring Laravel-inspired productivity to Bun. Wire up routes, controllers, React-powered
              Inertia pages, and Drizzle ORM in minutes — then iterate with instant feedback.
            </p>
            <div className="mt-10 flex flex-wrap gap-4">
              <Link
                href="/docs"
                className="inline-flex items-center gap-2 rounded-full bg-crimson-500 px-8 py-3.5 font-semibold text-white shadow-lg shadow-crimson-500/30 transition hover:-translate-y-0.5 hover:bg-crimson-600 hover:shadow-xl hover:shadow-crimson-500/40"
              >
                Browse docs
                <ArrowRightIcon className="size-4" />
              </Link>
              <Link
                href="/docs/guides/getting-started"
                className="inline-flex items-center gap-2 rounded-full border border-white/30 px-8 py-3.5 font-semibold text-white/90 transition hover:border-white/50 hover:text-white"
              >
                Quick start guide
              </Link>
            </div>
          </div>
        </section>

        {/* Code Showcase */}
        <section className="px-6 py-20">
          <div className="mx-auto grid max-w-5xl items-start gap-12 lg:grid-cols-2">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.3em] text-crimson-400">See it in action</p>
              <h2 className="mt-3 text-3xl font-bold text-white md:text-4xl">
                Elegant code, <br className="hidden sm:block" />powerful results
              </h2>
              <p className="mt-4 text-base leading-relaxed text-white/60">
                Define routes, build controllers, and query models with a clean, expressive API.
                Everything is fully typed — your editor knows your schema.
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
                Everything you need to ship fast
              </h2>
            </div>
            <div className="stagger-fade-in grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
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
                mistakes before you read the diff. And every new app ships agent guidance whose
                effect is measured in a public, reproducible evaluation — a 40% cut in agent cost
                over an undocumented baseline.
              </p>
              <CodeBlock
                lines={[
                  '$ bunx guren context   # project map for the agent',
                  '$ bunx guren check     # routes ↔ controllers ↔ pages',
                  '$ bunx guren audit     # validation, auth, secrets',
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
            <div className="stagger-fade-in grid gap-5 sm:grid-cols-3">
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

        {/* Stats Bar */}
        <section className="border-y border-white/10 bg-white/[0.02] px-6 py-12">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-8 text-center md:gap-16">
            {[
              { label: 'TypeScript-first', icon: <CodeBracketIcon className="mx-auto mb-2 size-6 text-crimson-400" /> },
              { label: 'MIT Licensed', icon: <ShieldCheckIcon className="mx-auto mb-2 size-6 text-crimson-400" /> },
              { label: 'Bun-native', icon: <RocketIcon className="mx-auto mb-2 size-6 text-crimson-400" /> },
            ].map((stat) => (
              <div key={stat.label}>
                {stat.icon}
                <p className="text-sm font-semibold text-white/80">{stat.label}</p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="relative overflow-hidden px-6 py-24">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(183,28,28,.15),transparent_70%)]"
          />
          <div className="relative mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold text-white md:text-4xl">Ready to build?</h2>
            <p className="mt-4 text-lg text-white/60">
              Guren is stable at v1.0 — get started in under a minute. No config, no boilerplate.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-4">
              <Link
                href="/docs/guides/getting-started"
                className="inline-flex items-center gap-2 rounded-full bg-crimson-500 px-8 py-3.5 font-semibold text-white shadow-lg shadow-crimson-500/30 transition hover:-translate-y-0.5 hover:bg-crimson-600"
              >
                Get started
                <ArrowRightIcon className="size-4" />
              </Link>
              <a
                href="https://github.com/gurenjs/guren"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-white/30 px-8 py-3.5 font-semibold text-white/90 transition hover:border-white/50 hover:text-white"
              >
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

import { Head, Link } from '@inertiajs/react'
import { useState } from 'react'
import type { HomePageProps } from './contracts.js'
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

const TAB_KEYS = ['Routes', 'Controller', 'Model'] as const
type TabKey = (typeof TAB_KEYS)[number]

export default function Home({ message, codeExamples }: HomePageProps) {
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

        {/* Stats Bar */}
        <section className="border-y border-white/10 bg-white/[0.02] px-6 py-12">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-8 text-center md:gap-16">
            {[
              { label: 'TypeScript-first', icon: <CodeBracketIcon className="mx-auto mb-2 size-6 text-crimson-400" /> },
              { label: 'MIT Licensed', icon: <ShieldCheckIcon className="mx-auto mb-2 size-6 text-crimson-400" /> },
              { label: 'Bun-native', icon: <RocketIcon className="mx-auto mb-2 size-6 text-crimson-400" /> },
              { label: 'v0.2.x Alpha', icon: <BoltIcon className="mx-auto mb-2 size-6 text-crimson-400" /> },
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
              Get started with Guren in under a minute. No config, no boilerplate.
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

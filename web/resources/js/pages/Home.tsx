import { Head, Link } from '@inertiajs/react'

interface HomeProps {
  message: string
}

const featureCards = [
  {
    title: 'Instant DX',
    body: 'Hot reload Bun server + Vite + Inertia keeps backend and frontend edits perfectly in sync.',
  },
  {
    title: 'Type-safe stack',
    body: 'Drizzle ORM powers eloquent-style models with full TypeScript inference out of the box.',
  },
  {
    title: 'CLI toolkit',
    body: 'Generators, route typing, and runtime helpers live under one `guren` command.',
  },
] as const

export default function Home({ message }: HomeProps) {
  return (
    <>
      <Head title="Web" />
      <main className="min-h-dvh bg-[radial-gradient(circle_at_10%_20%,rgba(255,190,190,.35),transparent_55%),radial-gradient(circle_at_85%_15%,rgba(183,28,28,.15),transparent_45%),#0f0a0a] px-6 py-6 text-crimson-50">
        <div className="mx-auto flex min-h-[80vh] max-w-5xl flex-col gap-10">
          <header className="flex flex-col gap-4 rounded-full border border-white/10 bg-black/30 px-8 py-5 text-white shadow-2xl shadow-black/50 backdrop-blur-xl md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-4">
              <img
                src="/public/logo.svg"
                alt="Guren logo"
                className="size-12 rounded-2xl p-1"
              />
              <p className="text-lg font-semibold">Guren</p>
            </div>
            <nav className="flex flex-wrap items-center gap-4 text-sm font-medium opacity-90">
              <Link href="/docs" className="transition hover:text-crimson-200">
                Docs
              </Link>
              <Link href="/docs/tutorials/overview" className="transition hover:text-crimson-200">
                Tutorials
              </Link>
              <a
                href="https://github.com/gurenjs/guren"
                target="_blank"
                rel="noreferrer"
                className="transition hover:text-crimson-200"
              >
                GitHub ↗
              </a>
            </nav>
          </header>

          <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-linear-135 from-white/15 via-white/5 to-white/10 px-10 py-12 shadow-[0_30px_70px_rgba(15,10,10,0.5)]">
            <div
              aria-hidden
              className="pointer-events-none absolute -right-16 -bottom-16 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(183,28,28,.35),transparent_65%)]"
            />
            <p className="text-sm font-semibold uppercase tracking-[0.35em] text-crimson-200">Bun-native MVC</p>
            <h1 className="mt-4 text-4xl font-semibold leading-tight text-white md:text-5xl">{message}</h1>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-white/80 md:text-lg">
              Bring Laravel-inspired productivity to Bun. Wire up routes, controllers, React-powered Inertia pages, and Drizzle ORM in
              minutes—then iterate with instant feedback.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link
                href="/docs"
                className="inline-flex items-center justify-center rounded-full bg-crimson-500 px-7 py-3 font-semibold text-white shadow-lg shadow-crimson-500/40 transition hover:-translate-y-0.5"
              >
                Browse docs
              </Link>
              <Link
                href="/docs/guides/getting-started"
                className="inline-flex items-center justify-center rounded-full border border-white/40 px-7 py-3 font-semibold text-white/90 transition hover:text-white"
              >
                Quick start guide
              </Link>
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-3">
            {featureCards.map((card) => (
              <article
                key={card.title}
                className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-[0_20px_40px_rgba(0,0,0,0.35)]"
              >
                <h3 className="text-lg font-semibold text-crimson-200">{card.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-white/80">{card.body}</p>
              </article>
            ))}
          </section>
        </div>
      </main>
    </>
  )
}

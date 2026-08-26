import { Head } from '@inertiajs/react'
interface Props {
  message: string
}

const features = [
  { title: 'Routing & Controllers', desc: 'Laravel-style MVC with type-safe route helpers' },
  { title: 'Eloquent-style ORM', desc: 'Drizzle-powered models with relations, scopes, and soft deletes' },
  { title: 'Inertia + React', desc: 'SPA-like UX without maintaining a separate frontend' },
  { title: 'Auth & Sessions', desc: 'Built-in authentication with guards, policies, and API tokens' },
  { title: 'Queue & Mail', desc: 'Background jobs, email sending, and event broadcasting' },
  { title: 'Zero-config SQLite', desc: 'No Docker needed — just bun install && bun run dev' },
]

export default function Home({ message }: Props) {
  return (
    <>
      <Head title="__APP_TITLE__" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl px-6 py-20">
          <p className="mb-5 font-mono text-xs tracking-[0.18em] uppercase text-g-text-2">
            Powered by Bun + Hono
          </p>
          <h1 className="mb-4 flex items-center gap-4 text-5xl font-bold tracking-tight text-g-heading">
            <span aria-hidden className="h-10 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
            {message}
          </h1>
          <p className="mb-8 text-lg text-g-text-2">
            The Laravel of TypeScript. Edit{' '}
            <code className="rounded bg-g-ink px-1.5 py-0.5 font-mono text-sm text-g-on-ink">
              resources/js/pages/Home.tsx
            </code>{' '}
            to get started.
          </p>

          <div className="mb-12 flex flex-wrap gap-3">
            <a
              href="https://guren.dev/docs"
              className="inline-flex items-center rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down"
            >
              Documentation
            </a>
            <a
              href="https://github.com/gurenjs/guren"
              className="inline-flex items-center rounded-g-ctl border border-g-line-strong bg-g-panel px-4 py-2 text-sm font-bold text-g-text transition hover:border-g-muted"
            >
              GitHub
            </a>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {features.map((f) => (
              <div
                key={f.title}
                className="rounded-g-card border border-g-line bg-g-panel p-5 shadow-g-card"
              >
                <h3 className="mb-1 font-bold text-g-heading">{f.title}</h3>
                <p className="text-sm text-g-text-2">{f.desc}</p>
              </div>
            ))}
          </div>

          <div className="mt-12 rounded-g-card bg-g-ink p-6">
            <h2 className="mb-3 font-mono text-xs tracking-[0.18em] uppercase text-g-on-ink-muted">
              Next steps
            </h2>
            <div className="space-y-2 font-mono text-sm text-g-on-ink">
              <p><span className="text-g-on-ink-muted">$</span> bunx guren add auth</p>
              <p><span className="text-g-on-ink-muted">$</span> bunx guren add resource posts</p>
              <p><span className="text-g-on-ink-muted">$</span> bunx guren make:model Post</p>
            </div>
          </div>
        </div>
      </main>
    </>
  )
}

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
      <main className="min-h-screen bg-gradient-to-b from-gray-950 to-gray-900 text-gray-100">
        <div className="mx-auto max-w-3xl px-6 py-20">
          <div className="mb-4 inline-block rounded-full bg-indigo-500/10 px-3 py-1 text-sm text-indigo-400">
            Powered by Bun + Hono
          </div>
          <h1 className="mb-4 text-5xl font-bold tracking-tight">{message}</h1>
          <p className="mb-12 text-lg text-gray-400">
            The Laravel of TypeScript. Edit{' '}
            <code className="rounded bg-gray-800 px-1.5 py-0.5 text-sm text-indigo-300">
              resources/js/pages/Home.tsx
            </code>{' '}
            to get started.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            {features.map((f) => (
              <div key={f.title} className="rounded-lg border border-gray-800 bg-gray-900/50 p-5">
                <h3 className="mb-1 font-semibold text-gray-100">{f.title}</h3>
                <p className="text-sm text-gray-400">{f.desc}</p>
              </div>
            ))}
          </div>

          <div className="mt-12 rounded-lg border border-gray-800 bg-gray-900/50 p-6">
            <h2 className="mb-3 text-lg font-semibold">Next steps</h2>
            <div className="space-y-2 font-mono text-sm text-gray-400">
              <p><span className="text-gray-500">$</span> bunx guren add auth</p>
              <p><span className="text-gray-500">$</span> bunx guren add resource posts</p>
              <p><span className="text-gray-500">$</span> bunx guren make:model Post</p>
            </div>
          </div>

          <p className="mt-8 text-center text-sm text-gray-600">
            <a href="https://guren.dev/docs" className="text-indigo-400 hover:text-indigo-300">
              Documentation
            </a>
            {' · '}
            <a href="https://github.com/user/guren" className="text-indigo-400 hover:text-indigo-300">
              GitHub
            </a>
          </p>
        </div>
      </main>
    </>
  )
}

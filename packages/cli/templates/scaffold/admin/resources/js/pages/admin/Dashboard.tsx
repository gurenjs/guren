type Props = {
  stats: {
    users: number
    posts: number
    comments: number
  }
}

export default function AdminDashboard({ stats }: Props) {
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-12">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-zinc-500">Admin</p>
        <h1 className="text-3xl font-semibold">Dashboard</h1>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <article className="rounded border p-4">
          <p className="text-sm text-zinc-500">Users</p>
          <p className="mt-2 text-2xl font-semibold">{stats.users}</p>
        </article>
        <article className="rounded border p-4">
          <p className="text-sm text-zinc-500">Posts</p>
          <p className="mt-2 text-2xl font-semibold">{stats.posts}</p>
        </article>
        <article className="rounded border p-4">
          <p className="text-sm text-zinc-500">Comments</p>
          <p className="mt-2 text-2xl font-semibold">{stats.comments}</p>
        </article>
      </section>
    </main>
  )
}

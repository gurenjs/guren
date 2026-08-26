import Layout from '../../components/Layout.js'

interface Props {
  user?: { id: number; name: string; email: string } | null
}

export default function Dashboard({ user }: Props) {
  return (
    <Layout>
      <section className="space-y-6">
        <header>
          <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
            <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
            Dashboard
          </h1>
          <p className="mt-2 text-sm text-g-text-2">This page is protected by the auth middleware.</p>
        </header>

        {user ? (
          <div className="rounded-g-card border border-g-line bg-g-panel p-6 shadow-g-card">
            <h2 className="text-xl font-bold text-g-heading">Signed in as {user.name}</h2>
            <p className="mt-2 text-sm text-g-text-2">Email: {user.email}</p>
          </div>
        ) : (
          <p className="flex gap-3 border-y border-g-line py-2.5 text-sm">
            <span className="w-10 shrink-0 text-right font-mono text-xs font-bold leading-5 text-g-danger">error</span>
            <span className="text-g-text">You are not signed in.</span>
          </p>
        )}
      </section>
    </Layout>
  )
}

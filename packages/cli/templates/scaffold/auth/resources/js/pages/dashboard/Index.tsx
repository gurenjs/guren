import Layout from '../../components/Layout.js'

interface Props {
  user?: { id: number; name: string; email: string } | null
}

export default function Dashboard({ user }: Props) {
  return (
    <Layout>
      <section className="space-y-6">
        <header>
          <h1 className="text-3xl font-semibold text-emerald-300">Dashboard</h1>
          <p className="mt-2 text-sm text-slate-400">This page is protected by the auth middleware.</p>
        </header>

        {user ? (
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-6 shadow-lg shadow-emerald-500/10">
            <h2 className="text-xl font-medium text-slate-100">Signed in as {user.name}</h2>
            <p className="mt-2 text-sm text-slate-300">Email: {user.email}</p>
          </div>
        ) : (
          <div className="rounded border border-rose-500/60 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            You are not signed in.
          </div>
        )}
      </section>
    </Layout>
  )
}

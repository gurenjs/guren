import Layout from '../../components/Layout.js'
import { Alert } from '@/resources/js/components/ui/Alert'

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
          <Alert tone="danger">You are not signed in.</Alert>
        )}
      </section>
    </Layout>
  )
}

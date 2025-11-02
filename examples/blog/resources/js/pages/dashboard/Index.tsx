import Layout from '../../components/Layout.js'

interface DashboardProps {
  user?: {
    id: number
    name: string
    email: string
  } | null
}

export default function Dashboard({ user }: DashboardProps) {
  return (
    <Layout>
      <section className="space-y-6">
        <header>
          <h1 className="text-3xl font-semibold text-[#B71C1C]">Dashboard</h1>
          <p className="mt-2 text-sm text-[#7A1A1A]">This page is protected by the auth middleware.</p>
        </header>

        {user ? (
          <div className="rounded-lg border border-[#F4B0B0] bg-white/80 p-6 shadow-lg shadow-[#B71C1C]/20 backdrop-blur">
            <h2 className="text-xl font-medium text-[#8F1111]">Signed in as {user.name}</h2>
            <p className="mt-2 text-sm text-[#A65555]">Email: {user.email}</p>
          </div>
        ) : (
          <div className="rounded border border-[#B71C1C]/40 bg-[#B71C1C]/10 px-4 py-3 text-sm text-[#7A0F0F]">
            You are not signed in.
          </div>
        )}
      </section>
    </Layout>
  )
}

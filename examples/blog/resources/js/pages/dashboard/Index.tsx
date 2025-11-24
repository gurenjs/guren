import { Link } from '@inertiajs/react'
import { User, Mail, Settings } from 'lucide-react'
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
    <Layout
      wrapperClassName="bg-zinc-50"
      mainClassName="max-w-5xl mx-auto px-6 py-12"
    >
      <div className="space-y-12">
        {/* Header Section */}
        <section className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
              Dashboard
            </h1>
            <p className="text-lg text-zinc-500">
              Manage your account and view your activity.
            </p>
          </div>
        </section>

        {/* Content Section */}
        <section>
          {user ? (
            <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200">
              <div className="border-b border-zinc-100 bg-zinc-50/50 px-6 py-4">
                <h2 className="text-base font-semibold text-zinc-900">Account Information</h2>
              </div>
              <div className="p-6">
                <div className="grid gap-6 sm:grid-cols-2">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-guren-50 text-guren-600">
                      <User className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-zinc-500">Full Name</p>
                      <p className="mt-1 text-base font-medium text-zinc-900">{user.name}</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-guren-50 text-guren-600">
                      <Mail className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-zinc-500">Email Address</p>
                      <p className="mt-1 text-base font-medium text-zinc-900">{user.email}</p>
                    </div>
                  </div>
                </div>

                <div className="mt-8 flex items-center pt-6 border-t border-zinc-100">
                  <Link
                    href="/profile"
                    className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-900 shadow-sm ring-1 ring-zinc-300 transition hover:bg-zinc-50"
                  >
                    <Settings className="h-4 w-4 text-zinc-500" />
                    Edit Profile
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 py-12 text-center">
              <p className="text-zinc-500">You are not signed in.</p>
              <div className="mt-4">
                <Link
                  href="/login"
                  className="inline-flex items-center justify-center rounded-full bg-guren-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-guren-500"
                >
                  Sign in
                </Link>
              </div>
            </div>
          )}
        </section>
      </div>
    </Layout>
  )
}

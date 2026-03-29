import { Link } from '@inertiajs/react'
import { User, Mail } from 'lucide-react'
import Layout from '../../components/Layout.js'
import { route } from '../../../../.guren/routes.gen'

interface Props {
  user?: { id: number; name: string; email: string } | null
}

export default function Dashboard({ user }: Props) {
  return (
    <Layout
      mainClassName="max-w-4xl mx-auto px-6 pt-10 pb-16 sm:pt-12 sm:pb-24"
    >
      <div className="space-y-12">
        {/* Header Section */}
        <section>
          <h1 className="text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">
            Dashboard
          </h1>
          <p className="mt-3 text-base text-stone-400">
            Manage your account and view your activity.
          </p>
        </section>

        {/* Content Section */}
        <section>
          {user ? (
            <div className="rounded-lg bg-white shadow-sm">
              <div className="p-8">
                <h2 className="text-sm font-medium uppercase tracking-widest text-stone-400">
                  Account Information
                </h2>
                <div className="mt-6 grid gap-8 sm:grid-cols-2">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-500">
                      <User className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-xs text-stone-400">Full Name</p>
                      <p className="mt-1 font-medium text-stone-900">{user.name}</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-500">
                      <Mail className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-xs text-stone-400">Email Address</p>
                      <p className="mt-1 font-medium text-stone-900">{user.email}</p>
                    </div>
                  </div>
                </div>

                <div className="mt-8 border-t border-stone-100 pt-6">
                  <Link
                    href={route('profile.edit')}
                    className="text-sm font-medium text-stone-600 underline-offset-4 transition-colors hover:text-stone-900 hover:underline"
                  >
                    Edit Profile
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-stone-500">You are not signed in.</p>
              <div className="mt-4">
                <Link
                  href={route('login')}
                  className="inline-flex items-center justify-center rounded-md bg-guren-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-guren-500"
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

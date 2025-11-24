import { Head, Link, usePage } from '@inertiajs/react'
import { useId, useState } from 'react'
import Layout from '../../components/Layout.js'
import { Check, Loader2, LogIn } from 'lucide-react'

interface LoginErrors {
  email?: string
  password?: string
  message?: string
}

export default function Login() {
  const page = usePage<{ email?: string; errors?: LoginErrors }>()
  const [email, setEmail] = useState(page.props.email ?? '')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const errors = page.props.errors ?? {}

  const emailId = useId()
  const passwordId = useId()

  const handleSubmit = () => {
    setIsLoading(true)
  }

  return (
    <Layout
      wrapperClassName="bg-zinc-50 flex flex-col"
      mainClassName="flex-1 flex items-center justify-center w-full max-w-none px-4 sm:px-6 lg:px-8 py-12"
    >
      <Head title="Sign in" />

      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-guren-600 text-white shadow-lg shadow-guren-200">
            <span className="text-2xl font-bold">G</span>
          </div>
          <h2 className="mt-6 text-3xl font-bold tracking-tight text-zinc-900">
            Sign in to your account
          </h2>
          <p className="mt-2 text-sm text-zinc-600">
            Or{' '}
            <Link href="/register" className="font-medium text-guren-600 hover:text-guren-500">
              contact your administrator
            </Link>
          </p>
        </div>

        <div className="bg-white px-6 py-8 shadow-xl ring-1 ring-zinc-200 sm:rounded-2xl sm:px-10">
          <div className="mb-6 rounded-lg bg-guren-50 p-4 text-sm text-guren-700">
            <p className="font-medium">Demo Credentials:</p>
            <p className="mt-1 font-mono">demo@guren.dev / secret</p>
          </div>

          {errors.message && (
            <div className="mb-6 rounded-lg bg-red-50 p-4 text-sm text-red-700 ring-1 ring-red-200">
              {errors.message}
            </div>
          )}

          <form method="post" action="/login" className="space-y-6" onSubmit={handleSubmit}>
            <div>
              <label htmlFor={emailId} className="block text-sm font-medium text-zinc-700">
                Email address
              </label>
              <div className="mt-2">
                <input
                  id={emailId}
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="block w-full rounded-lg border-0 py-2.5 px-3 text-zinc-900 shadow-sm ring-1 ring-inset ring-zinc-300 placeholder:text-zinc-400 focus:ring-2 focus:ring-inset focus:ring-guren-600 sm:text-sm sm:leading-6"
                />
              </div>
              {errors.email && <p className="mt-2 text-sm text-red-600">{errors.email}</p>}
            </div>

            <div>
              <label htmlFor={passwordId} className="block text-sm font-medium text-zinc-700">
                Password
              </label>
              <div className="mt-2">
                <input
                  id={passwordId}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="block w-full rounded-lg border-0 py-2.5 px-3 text-zinc-900 shadow-sm ring-1 ring-inset ring-zinc-300 placeholder:text-zinc-400 focus:ring-2 focus:ring-inset focus:ring-guren-600 sm:text-sm sm:leading-6"
                />
              </div>
              {errors.password && <p className="mt-2 text-sm text-red-600">{errors.password}</p>}
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <input
                  id="remember-me"
                  name="remember"
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4 w-4 rounded border-zinc-300 text-guren-600 focus:ring-guren-600"
                />
                <label htmlFor="remember-me" className="ml-2 block text-sm text-zinc-900">
                  Remember me
                </label>
              </div>

              <div className="text-sm">
                <a href="#" className="font-medium text-guren-600 hover:text-guren-500">
                  Forgot password?
                </a>
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={isLoading}
                className="flex w-full justify-center rounded-lg bg-guren-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-guren-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-guren-600 disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                ) : (
                  <LogIn className="mr-2 h-5 w-5" />
                )}
                Sign in
              </button>
            </div>
          </form>
        </div>
      </div>
    </Layout>
  )
}

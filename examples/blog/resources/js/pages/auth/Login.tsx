import { Head, Link } from '@inertiajs/react'
import { useId, useState } from 'react'
import Layout from '../../components/Layout.js'
import { Loader2 } from 'lucide-react'
import type { RouteErrors } from '@guren/inertia-client/typed-forms'
import type { ApiRoutes } from '../../../../.guren/api-client.gen'
import { route } from '../../../../.guren/routes.gen'

type LoginBody = ApiRoutes['login.store']['body']

interface Props {
  email?: string
  errors?: RouteErrors<LoginBody> & { message?: string }
}

export default function Login({ email: initialEmail = '', errors = {} }: Props) {
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const emailId = useId()
  const passwordId = useId()

  const handleSubmit = () => {
    setIsLoading(true)
  }

  return (
    <Layout
      wrapperClassName="flex flex-col"
      mainClassName="flex-1 flex items-center justify-center w-full max-w-none px-4 sm:px-6 lg:px-8 pt-10 pb-16"
    >
      <Head title="Sign in" />

      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <svg className="mx-auto h-11 w-auto" viewBox="0 0 299 516" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <path fillRule="evenodd" clipRule="evenodd" d="M120.853 0C169.647 25.1364 195.255 83.7877 184.353 136.5C175.756 178.065 136.039 208.749 137.372 253.138C138.729 298.251 168.879 330.194 161.353 377.5C181.444 352.982 200.458 332.078 208.353 300.5C214.367 261.839 179.943 229.848 190.898 190.72C194.731 177.22 208.153 147.3 231.353 136.5C218.919 181.573 237.455 211.003 266.353 245C300.243 280.246 308.266 343.188 284.853 386C253.141 442.376 189.378 465.573 149.853 515.5C121.558 476.749 77.5264 459.842 48.8528 424C-12.4118 347.419 -19.5127 245.133 47.3528 169C80.8397 130.872 165.348 59.327 120.853 0Z" fill="url(#login-logo-grad)"/>
            <defs>
              <linearGradient id="login-logo-grad" x1="149.117" y1="0" x2="149.117" y2="515.5" gradientUnits="userSpaceOnUse">
                <stop stopColor="#FF3C28"/>
                <stop offset="1" stopColor="#8B0000"/>
              </linearGradient>
            </defs>
          </svg>
          <h2 className="mt-6 text-2xl font-semibold tracking-tight text-stone-900">
            Sign in to your account
          </h2>
          <p className="mt-2 text-sm text-stone-400">
            Or{' '}
            <Link href="/register" className="font-medium text-stone-600 hover:text-stone-900">
              contact your administrator
            </Link>
          </p>
        </div>

        <div className="rounded-lg bg-white px-6 py-8 shadow-sm sm:px-10">
          <div className="mb-6 rounded-md bg-stone-50 border border-stone-200 p-4 text-sm text-stone-600">
            <p className="font-medium text-stone-700">Demo Credentials</p>
            <p className="mt-1 font-mono text-xs">demo@guren.dev / secret</p>
          </div>

          {errors.message && (
            <div className="mb-6 rounded-md bg-red-50 border border-red-200 p-4 text-sm text-red-700">
              {errors.message}
            </div>
          )}

          <form method="post" action={route('login.store')} className="space-y-6" onSubmit={handleSubmit}>
            <div>
              <label htmlFor={emailId} className="block text-sm font-medium text-stone-700">
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
                  className="block w-full rounded-md border-0 py-2.5 px-3 text-stone-900 shadow-sm ring-1 ring-inset ring-stone-200 placeholder:text-stone-300 focus:ring-2 focus:ring-inset focus:ring-stone-900 sm:text-sm sm:leading-6"
                />
              </div>
              {errors.email && <p className="mt-2 text-sm text-red-600">{errors.email}</p>}
            </div>

            <div>
              <label htmlFor={passwordId} className="block text-sm font-medium text-stone-700">
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
                  className="block w-full rounded-md border-0 py-2.5 px-3 text-stone-900 shadow-sm ring-1 ring-inset ring-stone-200 placeholder:text-stone-300 focus:ring-2 focus:ring-inset focus:ring-stone-900 sm:text-sm sm:leading-6"
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
                  className="h-4 w-4 rounded border-stone-300 text-guren-600 focus:ring-guren-600"
                />
                <label htmlFor="remember-me" className="ml-2 block text-sm text-stone-600">
                  Remember me
                </label>
              </div>

              <div className="text-sm">
                <a href="#" className="font-medium text-stone-500 hover:text-stone-700">
                  Forgot password?
                </a>
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={isLoading}
                className="flex w-full justify-center rounded-md bg-guren-600 px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-guren-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-guren-600 disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                ) : null}
                Sign in
              </button>
            </div>
          </form>
        </div>
      </div>
    </Layout>
  )
}

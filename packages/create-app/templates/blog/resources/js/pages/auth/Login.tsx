import { Head, Link, useForm } from '@inertiajs/react'
import { useId } from 'react'
import Layout from '../../components/Layout.js'
import type { ValidationErrors } from '@guren/core'

interface Props {
  email?: string
  errors?: ValidationErrors<'email' | 'password'>
}

type LoginFormData = {
  email: string
  password: string
  remember: boolean
}

export default function Login({ email = '', errors = {} }: Props) {
  const form = useForm<LoginFormData>({
    email,
    password: '',
    remember: false,
  })

  const emailId = useId()
  const passwordId = useId()

  return (
    <Layout>
      <Head title="Sign in" />
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-8 shadow-xl shadow-emerald-500/5">
        <h1 className="text-2xl font-semibold text-emerald-300">Sign in</h1>
        <p className="mt-2 text-sm text-slate-400">
          Use your account credentials to continue.
        </p>

        {errors.message && (
          <p className="mt-4 rounded border border-rose-500/60 bg-rose-500/10 px-4 py-2 text-sm text-rose-200">
            {errors.message}
          </p>
        )}

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            form.post('/login')
          }}
        >
          <div>
            <label htmlFor={emailId} className="block text-sm font-medium text-slate-200">
              Email
            </label>
            <input
              id={emailId}
              type="email"
              value={form.data.email}
              onChange={(event) => form.setData('email', event.target.value)}
              required
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {errors.email && <p className="mt-1 text-sm text-rose-300">{errors.email}</p>}
          </div>

          <div>
            <label htmlFor={passwordId} className="block text-sm font-medium text-slate-200">
              Password
            </label>
            <input
              id={passwordId}
              type="password"
              value={form.data.password}
              onChange={(event) => form.setData('password', event.target.value)}
              required
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {errors.password && <p className="mt-1 text-sm text-rose-300">{errors.password}</p>}
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={form.data.remember}
              onChange={(event) => form.setData('remember', event.target.checked)}
              className="h-4 w-4 rounded border-slate-700 bg-slate-950 text-emerald-400 focus:ring-emerald-400"
            />
            Remember me
          </label>

            <button
              type="submit"
              disabled={form.processing}
              className="w-full rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
            >
              Sign in
          </button>
        </form>


        <p className="mt-6 text-center text-sm text-slate-400">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="text-emerald-300 transition hover:text-emerald-200">
            Sign up
          </Link>
        </p>
      </section>
    </Layout>
  )
}

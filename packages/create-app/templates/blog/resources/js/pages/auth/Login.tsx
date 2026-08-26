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
      <section className="rounded-g-card border border-g-line bg-g-panel p-8 shadow-g-card">
        <h1 className="flex items-center gap-3 text-2xl font-bold text-g-heading">
          <span aria-hidden className="h-6 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
          Sign in
        </h1>
        <p className="mt-2 text-sm text-g-text-2">
          Use your account credentials to continue.
        </p>

        {errors.message && (
          <p className="mt-4 flex gap-3 border-y border-g-line py-2.5 text-sm">
            <span className="w-10 shrink-0 text-right font-mono text-xs font-bold leading-5 text-g-danger">error</span>
            <span className="text-g-text">{errors.message}</span>
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
            <label htmlFor={emailId} className="block text-sm font-bold text-g-heading">
              Email
            </label>
            <input
              id={emailId}
              type="email"
              value={form.data.email}
              onChange={(event) => form.setData('email', event.target.value)}
              required
              className="mt-1 w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
            />
            {errors.email && <p className="mt-1 text-sm text-g-danger">{errors.email}</p>}
          </div>

          <div>
            <label htmlFor={passwordId} className="block text-sm font-bold text-g-heading">
              Password
            </label>
            <input
              id={passwordId}
              type="password"
              value={form.data.password}
              onChange={(event) => form.setData('password', event.target.value)}
              required
              className="mt-1 w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
            />
            {errors.password && <p className="mt-1 text-sm text-g-danger">{errors.password}</p>}
          </div>

          <label className="flex items-center gap-2 text-sm text-g-text">
            <input
              type="checkbox"
              checked={form.data.remember}
              onChange={(event) => form.setData('remember', event.target.checked)}
              className="h-4 w-4 rounded accent-g-accent"
            />
            Remember me
          </label>

            <button
              type="submit"
              disabled={form.processing}
              className="w-full rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down disabled:cursor-not-allowed disabled:opacity-45"
            >
              Sign in
          </button>
        </form>


        <p className="mt-6 text-center text-sm text-g-text-2">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="text-g-accent-text transition hover:underline">
            Sign up
          </Link>
        </p>
      </section>
    </Layout>
  )
}

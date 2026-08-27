import { Head, Link, useForm } from '@inertiajs/react'
import { useId } from 'react'
import Layout from '../../components/Layout.js'
import type { ValidationErrors } from '@guren/core'

interface Props {
  errors?: ValidationErrors<'name' | 'email' | 'password' | 'passwordConfirmation'>
}

type RegisterFormData = {
  name: string
  email: string
  password: string
  passwordConfirmation: string
}

export default function Register({ errors = {} }: Props) {
  const form = useForm<RegisterFormData>({
    name: '',
    email: '',
    password: '',
    passwordConfirmation: '',
  })

  const nameId = useId()
  const emailId = useId()
  const passwordId = useId()
  const passwordConfirmationId = useId()

  return (
    <Layout>
      <Head title="Sign up" />
      <section className="rounded-g-card border border-g-line bg-g-panel p-8 shadow-g-card">
        <h1 className="flex items-center gap-3 text-2xl font-bold text-g-heading">
          <span aria-hidden className="h-6 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
          Create an account
        </h1>
        <p className="mt-2 text-sm text-g-text-2">
          Sign up to get started.
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
            form.post('/register')
          }}
        >
          <div>
            <label htmlFor={nameId} className="block text-sm font-bold text-g-heading">
              Name
            </label>
            <input
              id={nameId}
              type="text"
              value={form.data.name}
              onChange={(event) => form.setData('name', event.target.value)}
              required
              className="mt-1 w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
            />
            {errors.name && <p className="mt-1 text-sm text-g-danger">{errors.name}</p>}
          </div>

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

          <div>
            <label htmlFor={passwordConfirmationId} className="block text-sm font-bold text-g-heading">
              Confirm password
            </label>
            <input
              id={passwordConfirmationId}
              type="password"
              value={form.data.passwordConfirmation}
              onChange={(event) => form.setData('passwordConfirmation', event.target.value)}
              required
              className="mt-1 w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
            />
            {errors.passwordConfirmation && (
              <p className="mt-1 text-sm text-g-danger">{errors.passwordConfirmation}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={form.processing}
            className="w-full rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down disabled:cursor-not-allowed disabled:opacity-45"
          >
            Create account
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-g-text-2">
          Already have an account?{' '}
          <Link href="/login" className="text-g-accent-text transition hover:underline">
            Sign in
          </Link>
        </p>
      </section>
    </Layout>
  )
}

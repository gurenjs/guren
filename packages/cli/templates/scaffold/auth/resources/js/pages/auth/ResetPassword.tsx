import { Head, useForm } from '@inertiajs/react'
import { useId } from 'react'
import Layout from '../../components/Layout.js'
import type { ValidationErrors } from '@guren/core'

interface Props {
  token: string
  email: string
  errors?: ValidationErrors<'token' | 'password' | 'passwordConfirmation'>
}

type ResetPasswordFormData = {
  token: string
  password: string
  passwordConfirmation: string
}

export default function ResetPassword({ token, email, errors = {} }: Props) {
  const form = useForm<ResetPasswordFormData>({
    token,
    password: '',
    passwordConfirmation: '',
  })

  const passwordId = useId()
  const passwordConfirmationId = useId()

  return (
    <Layout>
      <Head title="Reset password" />
      <section className="rounded-g-card border border-g-line bg-g-panel p-8 shadow-g-card">
        <h1 className="flex items-center gap-3 text-2xl font-bold text-g-heading">
          <span aria-hidden className="h-6 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
          Reset your password
        </h1>
        {email ? (
          <p className="mt-2 text-sm text-g-text-2">
            Choose a new password for {email}.
          </p>
        ) : null}

        {errors.token && (
          <p className="mt-4 flex gap-3 border-y border-g-line py-2.5 text-sm">
            <span className="w-10 shrink-0 text-right font-mono text-xs font-bold leading-5 text-g-danger">error</span>
            <span className="text-g-text">{errors.token}</span>
          </p>
        )}

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            form.post('/reset-password')
          }}
        >
          <div>
            <label htmlFor={passwordId} className="block text-sm font-bold text-g-heading">
              New password
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
              Confirm new password
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
            Reset password
          </button>
        </form>
      </section>
    </Layout>
  )
}

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
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-8 shadow-xl shadow-emerald-500/5">
        <h1 className="text-2xl font-semibold text-emerald-300">Reset your password</h1>
        {email ? (
          <p className="mt-2 text-sm text-slate-400">
            Choose a new password for {email}.
          </p>
        ) : null}

        {errors.token && (
          <p className="mt-4 rounded border border-rose-500/60 bg-rose-500/10 px-4 py-2 text-sm text-rose-200">
            {errors.token}
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
            <label htmlFor={passwordId} className="block text-sm font-medium text-slate-200">
              New password
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

          <div>
            <label htmlFor={passwordConfirmationId} className="block text-sm font-medium text-slate-200">
              Confirm new password
            </label>
            <input
              id={passwordConfirmationId}
              type="password"
              value={form.data.passwordConfirmation}
              onChange={(event) => form.setData('passwordConfirmation', event.target.value)}
              required
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {errors.passwordConfirmation && (
              <p className="mt-1 text-sm text-rose-300">{errors.passwordConfirmation}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={form.processing}
            className="w-full rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            Reset password
          </button>
        </form>
      </section>
    </Layout>
  )
}

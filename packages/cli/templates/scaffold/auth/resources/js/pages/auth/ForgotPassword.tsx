import { Head, useForm } from '@inertiajs/react'
import { useId } from 'react'
import Layout from '../../components/Layout.js'
import type { ValidationErrors } from '@guren/core'

interface Props {
  errors?: ValidationErrors<'email'>
  status?: string
}

type ForgotPasswordFormData = {
  email: string
}

export default function ForgotPassword({ errors = {}, status }: Props) {
  const form = useForm<ForgotPasswordFormData>({ email: '' })

  const emailId = useId()

  return (
    <Layout>
      <Head title="Forgot password" />
      <section className="rounded-g-card border border-g-line bg-g-panel p-8 shadow-g-card">
        <h1 className="flex items-center gap-3 text-2xl font-bold text-g-heading">
          <span aria-hidden className="h-6 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
          Forgot your password?
        </h1>
        <p className="mt-2 text-sm text-g-text-2">
          Enter your email and we&apos;ll send you a link to reset your password.
        </p>

        {status ? (
          <p className="mt-4 flex gap-3 border-y border-g-line py-2.5 text-sm">
            <span className="w-10 shrink-0 text-right font-mono text-xs font-bold leading-5 text-g-ok">ok</span>
            <span className="text-g-text">{status}</span>
          </p>
        ) : null}

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
            form.post('/forgot-password')
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

          <button
            type="submit"
            disabled={form.processing}
            className="w-full rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down disabled:cursor-not-allowed disabled:opacity-45"
          >
            Send reset link
          </button>
        </form>
      </section>
    </Layout>
  )
}

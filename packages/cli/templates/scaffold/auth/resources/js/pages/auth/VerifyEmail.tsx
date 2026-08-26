import { Head, useForm } from '@inertiajs/react'
import Layout from '../../components/Layout.js'

interface Props {
  status?: string
}

export default function VerifyEmail({ status }: Props) {
  const form = useForm({})

  return (
    <Layout>
      <Head title="Verify email" />
      <section className="rounded-g-card border border-g-line bg-g-panel p-8 shadow-g-card">
        <h1 className="flex items-center gap-3 text-2xl font-bold text-g-heading">
          <span aria-hidden className="h-6 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
          Verify your email
        </h1>
        <p className="mt-2 text-sm text-g-text-2">
          We sent a verification link to your email address. Click it to activate your account.
        </p>

        {status ? (
          <p className="mt-4 flex gap-3 border-y border-g-line py-2.5 text-sm">
            <span className="w-10 shrink-0 text-right font-mono text-xs font-bold leading-5 text-g-ok">ok</span>
            <span className="text-g-text">{status}</span>
          </p>
        ) : null}

        <form
          className="mt-6"
          onSubmit={(event) => {
            event.preventDefault()
            form.post('/verify-email')
          }}
        >
          <button
            type="submit"
            disabled={form.processing}
            className="w-full rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down disabled:cursor-not-allowed disabled:opacity-45"
          >
            Resend verification email
          </button>
        </form>
      </section>
    </Layout>
  )
}

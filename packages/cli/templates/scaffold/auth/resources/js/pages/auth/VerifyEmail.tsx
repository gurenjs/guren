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
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-8 shadow-xl shadow-emerald-500/5">
        <h1 className="text-2xl font-semibold text-emerald-300">Verify your email</h1>
        <p className="mt-2 text-sm text-slate-400">
          We sent a verification link to your email address. Click it to activate your account.
        </p>

        {status ? (
          <p className="mt-4 rounded border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
            {status}
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
            className="w-full rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            Resend verification email
          </button>
        </form>
      </section>
    </Layout>
  )
}

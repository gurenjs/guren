import { Head, useForm } from '@inertiajs/react'
import Layout from '../../components/Layout.js'
import { Alert } from '@/resources/js/components/ui/Alert'
import { Button } from '@/resources/js/components/ui/Button'

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
          <Alert className="mt-4">{status}</Alert>
        ) : null}

        <form
          method="post"
          action="/verify-email"
          className="mt-6"
          onSubmit={(event) => {
            event.preventDefault()
            form.post('/verify-email')
          }}
        >
          <Button
            type="submit"
            disabled={form.processing}
            block
          >
            Resend verification email
          </Button>
        </form>
      </section>
    </Layout>
  )
}

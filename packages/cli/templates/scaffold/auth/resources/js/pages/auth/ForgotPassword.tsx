import { Head } from '@inertiajs/react'
import { useRouteForm } from '@guren/inertia-client/forms'
import Layout from '../../components/Layout.js'
import { forgotPasswordStoreForm } from '@/.guren/forms.gen'
import { Alert } from '@/resources/js/components/ui/Alert'
import { Button } from '@/resources/js/components/ui/Button'
import { Field } from '@/resources/js/components/ui/Field'
import type { ValidationErrors } from '@guren/core'

interface Props {
  errors?: ValidationErrors<'email'>
  status?: string
}

export default function ForgotPassword({ errors = {}, status }: Props) {
  const form = useRouteForm(forgotPasswordStoreForm, { email: '' })

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
          <Alert className="mt-4">{status}</Alert>
        ) : null}

        {errors.message && (
          <Alert tone="danger" className="mt-4">{errors.message}</Alert>
        )}

        <form method="post" action={forgotPasswordStoreForm.path} className="mt-6 space-y-4" onSubmit={form.handleSubmit}>
          <Field form={form} name="email" />
          <Button type="submit" disabled={form.processing} block>
            Send reset link
          </Button>
        </form>
      </section>
    </Layout>
  )
}

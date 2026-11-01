import { Head } from '@inertiajs/react'
import { useRouteForm } from '@guren/inertia-client/forms'
import Layout from '../../components/Layout.js'
import { resetPasswordStoreForm } from '@/.guren/forms.gen'
import { Alert } from '@/resources/js/components/ui/Alert'
import { Button } from '@/resources/js/components/ui/Button'
import { Field } from '@/resources/js/components/ui/Field'
import type { ValidationErrors } from '@guren/core'

interface Props {
  token: string
  email: string
  errors?: ValidationErrors<'token' | 'password' | 'passwordConfirmation'>
}

export default function ResetPassword({ token, email, errors = {} }: Props) {
  // The token rides in the form data with no control: its error shows above the form.
  const form = useRouteForm(resetPasswordStoreForm, { token, password: '', passwordConfirmation: '' })

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
          <Alert tone="danger" className="mt-4">{errors.token}</Alert>
        )}

        <form className="mt-6 space-y-4" onSubmit={form.handleSubmit}>
          <Field form={form} name="password" as="password" label="New password" />
          <Field form={form} name="passwordConfirmation" as="password" label="Confirm new password" />
          <Button type="submit" disabled={form.processing} block>
            Reset password
          </Button>
        </form>
      </section>
    </Layout>
  )
}

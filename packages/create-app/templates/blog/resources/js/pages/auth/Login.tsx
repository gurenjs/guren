import { Head, Link } from '@inertiajs/react'
import { useRouteForm } from '@guren/inertia-client/forms'
import Layout from '../../components/Layout.js'
import { loginStoreForm } from '@/.guren/forms.gen'
import { Alert } from '@/resources/js/components/ui/Alert'
import { Button } from '@/resources/js/components/ui/Button'
import { Field } from '@/resources/js/components/ui/Field'
import type { ValidationErrors } from '@guren/core'

interface Props {
  email?: string
  errors?: ValidationErrors<'email' | 'password'>
}

export default function Login({ email = '', errors = {} }: Props) {
  // Shows a redirect-back's field errors even when this form did not make the visit.
  const form = useRouteForm(loginStoreForm, { email, password: '', remember: false }, { adoptPageErrors: true })

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
          <Alert tone="danger" className="mt-4">{errors.message}</Alert>
        )}

        <form method="post" action={loginStoreForm.path} className="mt-6 space-y-4" onSubmit={form.handleSubmit}>
          <Field form={form} name="email" />
          <Field form={form} name="password" as="password" />
          <Field form={form} name="remember" label="Remember me" />
          <Button type="submit" disabled={form.processing} block>
            Sign in
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-g-text-2">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="text-g-accent-text underline underline-offset-2 transition hover:no-underline">
            Sign up
          </Link>
        </p>
      </section>
    </Layout>
  )
}

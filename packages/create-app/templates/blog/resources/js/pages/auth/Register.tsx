import { Head, Link } from '@inertiajs/react'
import { useRouteForm } from '@guren/inertia-client/forms'
import Layout from '../../components/Layout.js'
import { registerStoreForm } from '@/.guren/forms.gen'
import { Alert } from '@/resources/js/components/ui/Alert'
import { Button } from '@/resources/js/components/ui/Button'
import { Field } from '@/resources/js/components/ui/Field'
import type { ValidationErrors } from '@guren/core'

interface Props {
  errors?: ValidationErrors<'name' | 'email' | 'password' | 'passwordConfirmation'>
}

export default function Register({ errors = {} }: Props) {
  const form = useRouteForm(registerStoreForm, { name: '', email: '', password: '', passwordConfirmation: '' })

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
          <Alert tone="danger" className="mt-4">{errors.message}</Alert>
        )}

        <form className="mt-6 space-y-4" onSubmit={form.handleSubmit}>
          <Field form={form} name="name" />
          <Field form={form} name="email" as="email" />
          <Field form={form} name="password" as="password" />
          <Field form={form} name="passwordConfirmation" as="password" label="Confirm password" />
          <Button type="submit" disabled={form.processing} block>
            Create account
          </Button>
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

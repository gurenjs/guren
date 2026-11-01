import { Head } from '@inertiajs/react'
import { useRouteForm } from '@guren/inertia-client/forms'
import Layout from '../../components/Layout.js'
import { profileUpdateForm } from '@/.guren/forms.gen'
import { Alert } from '@/resources/js/components/ui/Alert'
import { Button } from '@/resources/js/components/ui/Button'
import { Field } from '@/resources/js/components/ui/Field'
import type { ValidationErrors } from '@guren/core'

interface Props {
  profile: { name: string; email: string }
  errors?: ValidationErrors<'name' | 'email' | 'password'>
  status?: string
}

export default function ProfileEdit({ profile, status }: Props) {
  const form = useRouteForm(profileUpdateForm, { name: profile.name, email: profile.email, password: '' })

  return (
    <Layout>
      <Head title="Profile" />
      <section className="space-y-6 rounded-g-card border border-g-line bg-g-panel p-8 shadow-g-card">
        <header>
          <h1 className="flex items-center gap-3 text-2xl font-bold text-g-heading">
            <span aria-hidden className="h-6 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
            Profile
          </h1>
          <p className="mt-2 text-sm text-g-text-2">Update your account details and password.</p>
        </header>

        {status ? (
          <Alert>{status}</Alert>
        ) : null}

        <form className="space-y-4" onSubmit={form.handleSubmit}>
          <Field form={form} name="name" />
          <Field form={form} name="email" as="email" />
          <Field form={form} name="password" as="password" label="New password" />
          <Button type="submit" disabled={form.processing} block>
            Save changes
          </Button>
        </form>
      </section>
    </Layout>
  )
}

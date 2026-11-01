import { Head, useForm } from '@inertiajs/react'
import { useId, type FormEvent } from 'react'
import Layout from '../../components/Layout.js'
import { Alert } from '@/resources/js/components/ui/Alert'
import { Button } from '@/resources/js/components/ui/Button'
import { Input } from '@/resources/js/components/ui/Input'
import { Label } from '@/resources/js/components/ui/Label'
import type { ValidationErrors } from '@guren/core'

interface Props {
  profile: { name: string; email: string }
  errors?: ValidationErrors<'name' | 'email' | 'password'>
  status?: string
}

type ProfileFormValues = {
  name: string
  email: string
  password: string
}

export default function ProfileEdit({ profile, status }: Props) {
  const form = useForm<ProfileFormValues>({
    name: profile.name,
    email: profile.email,
    password: '',
  })

  const nameId = useId()
  const emailId = useId()
  const passwordId = useId()

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    form.put('/profile')
  }

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

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <Label htmlFor={nameId}>
              Name
            </Label>
            <Input
              id={nameId}
              type="text"
              value={form.data.name}
              onChange={(event) => form.setData('name', event.target.value)}
              className="mt-1"
            />
            {form.errors.name ? <p className="mt-1 text-sm text-g-danger">{form.errors.name}</p> : null}
          </div>

          <div>
            <Label htmlFor={emailId}>
              Email
            </Label>
            <Input
              id={emailId}
              type="email"
              value={form.data.email}
              onChange={(event) => form.setData('email', event.target.value)}
              className="mt-1"
            />
            {form.errors.email ? <p className="mt-1 text-sm text-g-danger">{form.errors.email}</p> : null}
          </div>

          <div>
            <Label htmlFor={passwordId}>
              New password
            </Label>
            <Input
              id={passwordId}
              type="password"
              value={form.data.password}
              onChange={(event) => form.setData('password', event.target.value)}
              className="mt-1"
            />
            {form.errors.password ? <p className="mt-1 text-sm text-g-danger">{form.errors.password}</p> : null}
          </div>

          <Button
            type="submit"
            disabled={form.processing}
            block
          >
            Save changes
          </Button>
        </form>
      </section>
    </Layout>
  )
}

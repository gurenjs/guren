import { Head, Link, useForm } from '@inertiajs/react'
import { useId } from 'react'
import Layout from '../../components/Layout.js'
import { Alert } from '@/resources/js/components/ui/Alert'
import { Button } from '@/resources/js/components/ui/Button'
import { Input } from '@/resources/js/components/ui/Input'
import { Label } from '@/resources/js/components/ui/Label'
import type { ValidationErrors } from '@guren/core'

interface Props {
  errors?: ValidationErrors<'name' | 'email' | 'password' | 'passwordConfirmation'>
}

type RegisterFormData = {
  name: string
  email: string
  password: string
  passwordConfirmation: string
}

export default function Register({ errors = {} }: Props) {
  const form = useForm<RegisterFormData>({
    name: '',
    email: '',
    password: '',
    passwordConfirmation: '',
  })

  const nameId = useId()
  const emailId = useId()
  const passwordId = useId()
  const passwordConfirmationId = useId()

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

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            form.post('/register')
          }}
        >
          <div>
            <Label htmlFor={nameId}>
              Name
            </Label>
            <Input
              id={nameId}
              type="text"
              value={form.data.name}
              onChange={(event) => form.setData('name', event.target.value)}
              required
              className="mt-1"
            />
            {errors.name && <p className="mt-1 text-sm text-g-danger">{errors.name}</p>}
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
              required
              className="mt-1"
            />
            {errors.email && <p className="mt-1 text-sm text-g-danger">{errors.email}</p>}
          </div>

          <div>
            <Label htmlFor={passwordId}>
              Password
            </Label>
            <Input
              id={passwordId}
              type="password"
              value={form.data.password}
              onChange={(event) => form.setData('password', event.target.value)}
              required
              className="mt-1"
            />
            {errors.password && <p className="mt-1 text-sm text-g-danger">{errors.password}</p>}
          </div>

          <div>
            <Label htmlFor={passwordConfirmationId}>
              Confirm password
            </Label>
            <Input
              id={passwordConfirmationId}
              type="password"
              value={form.data.passwordConfirmation}
              onChange={(event) => form.setData('passwordConfirmation', event.target.value)}
              required
              className="mt-1"
            />
            {errors.passwordConfirmation && (
              <p className="mt-1 text-sm text-g-danger">{errors.passwordConfirmation}</p>
            )}
          </div>

          <Button
            type="submit"
            disabled={form.processing}
            block
          >
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

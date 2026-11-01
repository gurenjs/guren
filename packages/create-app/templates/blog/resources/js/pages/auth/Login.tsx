import { Head, Link, useForm } from '@inertiajs/react'
import { useId } from 'react'
import Layout from '../../components/Layout.js'
import { Alert } from '@/resources/js/components/ui/Alert'
import { Button } from '@/resources/js/components/ui/Button'
import { Checkbox } from '@/resources/js/components/ui/Checkbox'
import { Input } from '@/resources/js/components/ui/Input'
import { Label } from '@/resources/js/components/ui/Label'
import type { ValidationErrors } from '@guren/core'

interface Props {
  email?: string
  errors?: ValidationErrors<'email' | 'password'>
}

type LoginFormData = {
  email: string
  password: string
  remember: boolean
}

export default function Login({ email = '', errors = {} }: Props) {
  const form = useForm<LoginFormData>({
    email,
    password: '',
    remember: false,
  })

  const emailId = useId()
  const passwordId = useId()

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

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            form.post('/login')
          }}
        >
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

          <Checkbox
            label="Remember me"
            checked={form.data.remember}
            onChange={(event) => form.setData('remember', event.target.checked)}
            className="text-sm text-g-text"
          />

            <Button
              type="submit"
              disabled={form.processing}
              block
            >
              Sign in
          </Button>
        </form>


        <p className="mt-6 text-center text-sm text-g-text-2">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="text-g-accent-text transition hover:underline">
            Sign up
          </Link>
        </p>
      </section>
    </Layout>
  )
}

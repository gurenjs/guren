import { Head, useForm } from '@inertiajs/react'
import { useId } from 'react'
import Layout from '../../components/Layout.js'
import { Alert } from '@/resources/js/components/ui/Alert'
import { Button } from '@/resources/js/components/ui/Button'
import { Input } from '@/resources/js/components/ui/Input'
import { Label } from '@/resources/js/components/ui/Label'
import type { ValidationErrors } from '@guren/core'

interface Props {
  token: string
  email: string
  errors?: ValidationErrors<'token' | 'password' | 'passwordConfirmation'>
}

type ResetPasswordFormData = {
  token: string
  password: string
  passwordConfirmation: string
}

export default function ResetPassword({ token, email, errors = {} }: Props) {
  const form = useForm<ResetPasswordFormData>({
    token,
    password: '',
    passwordConfirmation: '',
  })

  const passwordId = useId()
  const passwordConfirmationId = useId()

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

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            form.post('/reset-password')
          }}
        >
          <div>
            <Label htmlFor={passwordId}>
              New password
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
              Confirm new password
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
            Reset password
          </Button>
        </form>
      </section>
    </Layout>
  )
}

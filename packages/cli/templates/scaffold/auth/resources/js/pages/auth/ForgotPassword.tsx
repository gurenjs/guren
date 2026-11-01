import { Head, useForm } from '@inertiajs/react'
import { useId } from 'react'
import Layout from '../../components/Layout.js'
import { Alert } from '@/resources/js/components/ui/Alert'
import { Button } from '@/resources/js/components/ui/Button'
import { Input } from '@/resources/js/components/ui/Input'
import { Label } from '@/resources/js/components/ui/Label'
import type { ValidationErrors } from '@guren/core'

interface Props {
  errors?: ValidationErrors<'email'>
  status?: string
}

type ForgotPasswordFormData = {
  email: string
}

export default function ForgotPassword({ errors = {}, status }: Props) {
  const form = useForm<ForgotPasswordFormData>({ email: '' })

  const emailId = useId()

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

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            form.post('/forgot-password')
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

          <Button
            type="submit"
            disabled={form.processing}
            block
          >
            Send reset link
          </Button>
        </form>
      </section>
    </Layout>
  )
}

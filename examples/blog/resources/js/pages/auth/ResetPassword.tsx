import { Head, usePage } from '@inertiajs/react'
import { useState } from 'react'
import Layout from '../../components/Layout.js'
import AuthCard from '../../components/AuthCard.js'
import AuthFormField from '../../components/AuthFormField.js'
import { Loader2 } from 'lucide-react'
import type { RouteErrors } from '@guren/inertia-client/typed-forms'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import { route } from '@/.guren/routes.gen'

type ResetPasswordBody = ApiRoutes['reset-password.store']['body']

interface Props {
  token: string
  email: string
  errors?: RouteErrors<ResetPasswordBody> & { message?: string }
}

export default function ResetPassword({ token, email, errors = {} }: Props) {
  const { props } = usePage<{ csrfToken?: string }>()
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = () => {
    setIsLoading(true)
  }

  return (
    <Layout
      wrapperClassName="flex flex-col"
      mainClassName="flex-1 flex items-center justify-center w-full max-w-none px-4 sm:px-6 lg:px-8 pt-10 pb-16"
    >
      <Head title="Reset password" />

      <AuthCard title="Reset your password" subtitle={email ? `Choose a new password for ${email}.` : undefined}>
        {(errors.token || errors.message) && (
          <div className="mb-6 rounded-md bg-red-50 border border-red-200 p-4 text-sm text-red-700">
            {errors.token ?? errors.message}
          </div>
        )}

        <form method="post" action={route('reset-password.store')} className="space-y-6" onSubmit={handleSubmit}>
          {props.csrfToken && <input type="hidden" name="_token" value={props.csrfToken} />}
          <input type="hidden" name="token" value={token} />
          <AuthFormField
            label="New password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            error={errors.password}
          />
          <AuthFormField
            label="Confirm new password"
            name="passwordConfirmation"
            type="password"
            autoComplete="new-password"
            value={passwordConfirmation}
            onChange={setPasswordConfirmation}
            error={errors.passwordConfirmation}
          />

          <div>
            <button
              type="submit"
              disabled={isLoading}
              className="flex w-full justify-center rounded-md bg-guren-600 px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-guren-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-guren-600 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              ) : null}
              Reset password
            </button>
          </div>
        </form>
      </AuthCard>
    </Layout>
  )
}

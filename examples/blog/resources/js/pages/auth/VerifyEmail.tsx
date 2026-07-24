import { Head, usePage } from '@inertiajs/react'
import { useState } from 'react'
import Layout from '../../components/Layout.js'
import AuthCard from '../../components/AuthCard.js'
import { Loader2 } from 'lucide-react'
import { route } from '@/.guren/routes.gen'

interface Props {
  status?: string
}

export default function VerifyEmail({ status }: Props) {
  const { props } = usePage<{ csrfToken?: string }>()
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = () => {
    setIsLoading(true)
  }

  return (
    <Layout
      wrapperClassName="flex flex-col"
      mainClassName="flex-1 flex items-center justify-center w-full max-w-none px-4 sm:px-6 lg:px-8 pt-10 pb-16"
    >
      <Head title="Verify email" />

      <AuthCard
        title="Verify your email"
        subtitle="We sent a verification link to your email address. Click it to activate your account."
      >
        {status && (
          <div className="mb-6 rounded-md bg-stone-50 border border-stone-200 p-4 text-sm text-stone-600">
            {status}
          </div>
        )}

        <form method="post" action={route('verify-email.resend')} onSubmit={handleSubmit}>
          {props.csrfToken && <input type="hidden" name="_token" value={props.csrfToken} />}
          <button
            type="submit"
            disabled={isLoading}
            className="flex w-full justify-center rounded-md bg-guren-600 px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-guren-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-guren-600 disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            ) : null}
            Resend verification email
          </button>
        </form>
      </AuthCard>
    </Layout>
  )
}

import { useForm } from '@inertiajs/react'
import type { FormEvent } from 'react'
import { useEffect } from 'react'
import Layout from '../../components/Layout.js'
import { AlertCircle } from 'lucide-react'
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
  passwordConfirmation: string
}

export default function EditProfile({ profile, status }: Props) {

  const form = useForm<ProfileFormValues>({
    name: profile?.name ?? '',
    email: profile?.email ?? '',
    password: '',
    passwordConfirmation: '',
  })

  useEffect(() => {
    if (status) {
      form.reset('password', 'passwordConfirmation')
    }
  }, [status])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    form.put('/profile')
  }

  return (
    <Layout mainClassName="max-w-4xl mx-auto px-6 pt-10 pb-16 sm:pt-12 sm:pb-24">
      <div className="space-y-10">
        <section>
          <h1 className="text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">
            Edit Profile
          </h1>
          <p className="mt-3 text-base text-stone-400">
            Update your basic account details and password.
          </p>
        </section>

        {status ? (
          <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <AlertCircle className="h-4 w-4" />
            {status}
          </div>
        ) : null}

        <div className="rounded-lg bg-white p-8 shadow-sm sm:p-10">
          <form onSubmit={handleSubmit} className="space-y-8">
            <div className="grid gap-8 sm:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="name" className="block text-sm font-medium text-stone-700">
                  Name
                </label>
                <input
                  id="name"
                  type="text"
                  value={form.data.name}
                  onChange={(event) => form.setData('name', event.target.value)}
                  className={`block w-full rounded-md border-0 py-2.5 px-3 text-stone-900 shadow-sm ring-1 ring-inset placeholder:text-stone-300 focus:ring-2 focus:ring-inset sm:text-sm sm:leading-6 ${form.errors.name
                    ? 'ring-red-300 focus:ring-red-500'
                    : 'ring-stone-200 focus:ring-stone-900'
                    }`}
                  autoComplete="name"
                  placeholder="Your full name"
                />
                {form.errors.name ? (
                  <p className="flex items-center gap-1 text-sm text-red-600">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {form.errors.name}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <label htmlFor="email" className="block text-sm font-medium text-stone-700">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={form.data.email}
                  onChange={(event) => form.setData('email', event.target.value)}
                  className={`block w-full rounded-md border-0 py-2.5 px-3 text-stone-900 shadow-sm ring-1 ring-inset placeholder:text-stone-300 focus:ring-2 focus:ring-inset sm:text-sm sm:leading-6 ${form.errors.email
                    ? 'ring-red-300 focus:ring-red-500'
                    : 'ring-stone-200 focus:ring-stone-900'
                    }`}
                  autoComplete="email"
                  placeholder="you@example.com"
                />
                {form.errors.email ? (
                  <p className="flex items-center gap-1 text-sm text-red-600">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {form.errors.email}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <label htmlFor="password" className="block text-sm font-medium text-stone-700">
                  New Password <span className="text-xs font-normal text-stone-400">(leave blank to keep current)</span>
                </label>
                <input
                  id="password"
                  type="password"
                  value={form.data.password}
                  onChange={(event) => form.setData('password', event.target.value)}
                  className={`block w-full rounded-md border-0 py-2.5 px-3 text-stone-900 shadow-sm ring-1 ring-inset placeholder:text-stone-300 focus:ring-2 focus:ring-inset sm:text-sm sm:leading-6 ${form.errors.password
                    ? 'ring-red-300 focus:ring-red-500'
                    : 'ring-stone-200 focus:ring-stone-900'
                    }`}
                  autoComplete="new-password"
                  placeholder="••••••••"
                />
                {form.errors.password ? (
                  <p className="flex items-center gap-1 text-sm text-red-600">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {form.errors.password}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <label htmlFor="passwordConfirmation" className="block text-sm font-medium text-stone-700">
                  Confirm Password
                </label>
                <input
                  id="passwordConfirmation"
                  type="password"
                  value={form.data.passwordConfirmation}
                  onChange={(event) => form.setData('passwordConfirmation', event.target.value)}
                  className={`block w-full rounded-md border-0 py-2.5 px-3 text-stone-900 shadow-sm ring-1 ring-inset placeholder:text-stone-300 focus:ring-2 focus:ring-inset sm:text-sm sm:leading-6 ${form.errors.passwordConfirmation
                    ? 'ring-red-300 focus:ring-red-500'
                    : 'ring-stone-200 focus:ring-stone-900'
                    }`}
                  autoComplete="new-password"
                  placeholder="••••••••"
                />
                {form.errors.passwordConfirmation ? (
                  <p className="flex items-center gap-1 text-sm text-red-600">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {form.errors.passwordConfirmation}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-stone-100 pt-6 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md bg-stone-100 px-5 py-2.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-200"
                onClick={() => form.reset('password', 'passwordConfirmation')}
              >
                Reset Password Fields
              </button>
              <button
                type="submit"
                className="inline-flex items-center justify-center rounded-md bg-stone-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={form.processing}
              >
                {form.processing ? (
                  <>
                    <svg className="mr-2 h-4 w-4 animate-spin text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Saving...
                  </>
                ) : (
                  'Save Changes'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Layout>
  )
}

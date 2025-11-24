import { useForm, usePage } from '@inertiajs/react'
import type { FormEvent } from 'react'
import { useEffect } from 'react'
import Layout from '../../components/Layout.js'
import { User, Mail, Lock, Save, RotateCcw, AlertCircle } from 'lucide-react'

type ProfileFormValues = {
  name: string
  email: string
  password: string
  passwordConfirmation: string
}

type ProfilePageProps = {
  profile: {
    name: string
    email: string
  }
  status?: string
}

export default function EditProfile() {
  const { profile, status } = usePage<ProfilePageProps>().props

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
    <Layout wrapperClassName="bg-zinc-50" mainClassName="max-w-4xl mx-auto px-6 py-12">
      <div className="space-y-8">
        <section className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Edit Profile
          </h1>
          <p className="text-lg text-zinc-500">
            Update your basic account details and password.
          </p>
        </section>

        {status ? (
          <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <AlertCircle className="h-4 w-4" />
            {status}
          </div>
        ) : null}

        <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-zinc-200">
          <form onSubmit={handleSubmit} className="space-y-8">
            <div className="grid gap-8 sm:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="name" className="block text-sm font-medium text-zinc-900">
                  Name
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <User className="h-5 w-5 text-zinc-400" />
                  </div>
                  <input
                    id="name"
                    type="text"
                    value={form.data.name}
                    onChange={(event) => form.setData('name', event.target.value)}
                    className={`block w-full rounded-lg border-0 py-2.5 pl-10 pr-3 text-zinc-900 shadow-sm ring-1 ring-inset placeholder:text-zinc-400 focus:ring-2 focus:ring-inset sm:text-sm sm:leading-6 ${form.errors.name
                      ? 'ring-red-300 focus:ring-red-500'
                      : 'ring-zinc-300 focus:ring-guren-600'
                      }`}
                    autoComplete="name"
                    placeholder="Your full name"
                  />
                </div>
                {form.errors.name ? (
                  <p className="flex items-center gap-1 text-sm text-red-600">
                    <AlertCircle className="h-4 w-4" />
                    {form.errors.name}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <label htmlFor="email" className="block text-sm font-medium text-zinc-900">
                  Email
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Mail className="h-5 w-5 text-zinc-400" />
                  </div>
                  <input
                    id="email"
                    type="email"
                    value={form.data.email}
                    onChange={(event) => form.setData('email', event.target.value)}
                    className={`block w-full rounded-lg border-0 py-2.5 pl-10 pr-3 text-zinc-900 shadow-sm ring-1 ring-inset placeholder:text-zinc-400 focus:ring-2 focus:ring-inset sm:text-sm sm:leading-6 ${form.errors.email
                      ? 'ring-red-300 focus:ring-red-500'
                      : 'ring-zinc-300 focus:ring-guren-600'
                      }`}
                    autoComplete="email"
                    placeholder="you@example.com"
                  />
                </div>
                {form.errors.email ? (
                  <p className="flex items-center gap-1 text-sm text-red-600">
                    <AlertCircle className="h-4 w-4" />
                    {form.errors.email}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <label htmlFor="password" className="block text-sm font-medium text-zinc-900">
                  New Password <span className="text-xs font-normal text-zinc-500">(leave blank to keep current)</span>
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Lock className="h-5 w-5 text-zinc-400" />
                  </div>
                  <input
                    id="password"
                    type="password"
                    value={form.data.password}
                    onChange={(event) => form.setData('password', event.target.value)}
                    className={`block w-full rounded-lg border-0 py-2.5 pl-10 pr-3 text-zinc-900 shadow-sm ring-1 ring-inset placeholder:text-zinc-400 focus:ring-2 focus:ring-inset sm:text-sm sm:leading-6 ${form.errors.password
                      ? 'ring-red-300 focus:ring-red-500'
                      : 'ring-zinc-300 focus:ring-guren-600'
                      }`}
                    autoComplete="new-password"
                    placeholder="••••••••"
                  />
                </div>
                {form.errors.password ? (
                  <p className="flex items-center gap-1 text-sm text-red-600">
                    <AlertCircle className="h-4 w-4" />
                    {form.errors.password}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <label htmlFor="passwordConfirmation" className="block text-sm font-medium text-zinc-900">
                  Confirm Password
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Lock className="h-5 w-5 text-zinc-400" />
                  </div>
                  <input
                    id="passwordConfirmation"
                    type="password"
                    value={form.data.passwordConfirmation}
                    onChange={(event) => form.setData('passwordConfirmation', event.target.value)}
                    className={`block w-full rounded-lg border-0 py-2.5 pl-10 pr-3 text-zinc-900 shadow-sm ring-1 ring-inset placeholder:text-zinc-400 focus:ring-2 focus:ring-inset sm:text-sm sm:leading-6 ${form.errors.passwordConfirmation
                      ? 'ring-red-300 focus:ring-red-500'
                      : 'ring-zinc-300 focus:ring-guren-600'
                      }`}
                    autoComplete="new-password"
                    placeholder="••••••••"
                  />
                </div>
                {form.errors.passwordConfirmation ? (
                  <p className="flex items-center gap-1 text-sm text-red-600">
                    <AlertCircle className="h-4 w-4" />
                    {form.errors.passwordConfirmation}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col-reverse gap-4 border-t border-zinc-100 pt-6 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-6 py-2.5 text-sm font-medium text-zinc-700 shadow-sm ring-1 ring-inset ring-zinc-300 transition hover:bg-zinc-50"
                onClick={() => form.reset('password', 'passwordConfirmation')}
              >
                <RotateCcw className="h-4 w-4" />
                Reset Password Fields
              </button>
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-guren-600 px-6 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-guren-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-guren-600 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={form.processing}
              >
                {form.processing ? (
                  <>
                    <svg className="h-4 w-4 animate-spin text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    Save Changes
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Layout>
  )
}

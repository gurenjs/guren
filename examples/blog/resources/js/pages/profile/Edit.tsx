import { useForm, usePage } from '@inertiajs/react'
import type { FormEvent } from 'react'
import { useEffect } from 'react'
import Layout from '../../components/Layout.js'

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
    <Layout mainClassName="mx-auto w-full max-w-2xl py-12" wrapperClassName="bg-[#FFF5F5]">
      <section className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold text-[#B71C1C]">Edit Profile</h1>
          <p className="text-sm text-[#7A1A1A]">Update your basic account details and password.</p>
        </header>

        {status ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {status}
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-6 rounded-2xl border border-[#F4B0B0] bg-white/90 p-6 shadow-lg shadow-[#B71C1C]/10 backdrop-blur">
          <div className="space-y-1">
            <label htmlFor="name" className="text-sm font-medium text-[#8F1111]">
              Name
            </label>
            <input
              id="name"
              type="text"
              value={form.data.name}
              onChange={(event) => form.setData('name', event.target.value)}
              className="w-full rounded-lg border border-[#F5C5C5] bg-white px-3 py-2 text-sm text-[#3C0A0A] shadow-sm focus:border-[#B71C1C] focus:outline-none focus:ring-2 focus:ring-[#F5C5C5]"
              autoComplete="name"
            />
            {form.errors.name ? <p className="text-xs text-[#B71C1C]">{form.errors.name}</p> : null}
          </div>

          <div className="space-y-1">
            <label htmlFor="email" className="text-sm font-medium text-[#8F1111]">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={form.data.email}
              onChange={(event) => form.setData('email', event.target.value)}
              className="w-full rounded-lg border border-[#F5C5C5] bg-white px-3 py-2 text-sm text-[#3C0A0A] shadow-sm focus:border-[#B71C1C] focus:outline-none focus:ring-2 focus:ring-[#F5C5C5]"
              autoComplete="email"
            />
            {form.errors.email ? <p className="text-xs text-[#B71C1C]">{form.errors.email}</p> : null}
          </div>

          <div className="space-y-1">
            <label htmlFor="password" className="text-sm font-medium text-[#8F1111]">
              New Password <span className="text-xs text-[#A65555]">(leave blank to keep current password)</span>
            </label>
            <input
              id="password"
              type="password"
              value={form.data.password}
              onChange={(event) => form.setData('password', event.target.value)}
              className="w-full rounded-lg border border-[#F5C5C5] bg-white px-3 py-2 text-sm text-[#3C0A0A] shadow-sm focus:border-[#B71C1C] focus:outline-none focus:ring-2 focus:ring-[#F5C5C5]"
              autoComplete="new-password"
            />
            {form.errors.password ? <p className="text-xs text-[#B71C1C]">{form.errors.password}</p> : null}
          </div>

          <div className="space-y-1">
            <label htmlFor="passwordConfirmation" className="text-sm font-medium text-[#8F1111]">
              Confirm Password
            </label>
            <input
              id="passwordConfirmation"
              type="password"
              value={form.data.passwordConfirmation}
              onChange={(event) => form.setData('passwordConfirmation', event.target.value)}
              className="w-full rounded-lg border border-[#F5C5C5] bg-white px-3 py-2 text-sm text-[#3C0A0A] shadow-sm focus:border-[#B71C1C] focus:outline-none focus:ring-2 focus:ring-[#F5C5C5]"
              autoComplete="new-password"
            />
            {form.errors.passwordConfirmation ? (
              <p className="text-xs text-[#B71C1C]">{form.errors.passwordConfirmation}</p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              className="rounded-lg border border-[#F5C5C5] px-4 py-2 text-sm font-medium text-[#8F1111] transition hover:bg-[#F5C5C5]/50"
              onClick={() => form.reset('password', 'passwordConfirmation')}
            >
              Reset Password Fields
            </button>
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-lg bg-[#B71C1C] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-[#B71C1C]/30 transition hover:bg-[#8F1111] disabled:opacity-60"
              disabled={form.processing}
            >
              {form.processing ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </section>
    </Layout>
  )
}

import { Head, useForm } from '@inertiajs/react'
import type { FormEvent } from 'react'
import Layout from '../../components/Layout.js'
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

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    form.put('/profile')
  }

  return (
    <Layout>
      <Head title="Profile" />
      <section className="space-y-6 rounded-lg border border-slate-800 bg-slate-900/40 p-8 shadow-xl shadow-emerald-500/5">
        <header>
          <h1 className="text-2xl font-semibold text-emerald-300">Profile</h1>
          <p className="mt-2 text-sm text-slate-400">Update your account details and password.</p>
        </header>

        {status ? (
          <p className="rounded border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
            {status}
          </p>
        ) : null}

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="block text-sm font-medium text-slate-200">Name</label>
            <input
              type="text"
              value={form.data.name}
              onChange={(event) => form.setData('name', event.target.value)}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {form.errors.name ? <p className="mt-1 text-sm text-rose-300">{form.errors.name}</p> : null}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-200">Email</label>
            <input
              type="email"
              value={form.data.email}
              onChange={(event) => form.setData('email', event.target.value)}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {form.errors.email ? <p className="mt-1 text-sm text-rose-300">{form.errors.email}</p> : null}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-200">New password</label>
            <input
              type="password"
              value={form.data.password}
              onChange={(event) => form.setData('password', event.target.value)}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {form.errors.password ? <p className="mt-1 text-sm text-rose-300">{form.errors.password}</p> : null}
          </div>

          <button
            type="submit"
            disabled={form.processing}
            className="w-full rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            Save changes
          </button>
        </form>
      </section>
    </Layout>
  )
}

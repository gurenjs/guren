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
      <section className="space-y-6 rounded-g-card border border-g-line bg-g-panel p-8 shadow-g-card">
        <header>
          <h1 className="flex items-center gap-3 text-2xl font-bold text-g-heading">
            <span aria-hidden className="h-6 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
            Profile
          </h1>
          <p className="mt-2 text-sm text-g-text-2">Update your account details and password.</p>
        </header>

        {status ? (
          <p className="flex gap-3 border-y border-g-line py-2.5 text-sm">
            <span className="w-10 shrink-0 text-right font-mono text-xs font-bold leading-5 text-g-ok">ok</span>
            <span className="text-g-text">{status}</span>
          </p>
        ) : null}

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="block text-sm font-bold text-g-heading">Name</label>
            <input
              type="text"
              value={form.data.name}
              onChange={(event) => form.setData('name', event.target.value)}
              className="mt-1 w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
            />
            {form.errors.name ? <p className="mt-1 text-sm text-g-danger">{form.errors.name}</p> : null}
          </div>

          <div>
            <label className="block text-sm font-bold text-g-heading">Email</label>
            <input
              type="email"
              value={form.data.email}
              onChange={(event) => form.setData('email', event.target.value)}
              className="mt-1 w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
            />
            {form.errors.email ? <p className="mt-1 text-sm text-g-danger">{form.errors.email}</p> : null}
          </div>

          <div>
            <label className="block text-sm font-bold text-g-heading">New password</label>
            <input
              type="password"
              value={form.data.password}
              onChange={(event) => form.setData('password', event.target.value)}
              className="mt-1 w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
            />
            {form.errors.password ? <p className="mt-1 text-sm text-g-danger">{form.errors.password}</p> : null}
          </div>

          <button
            type="submit"
            disabled={form.processing}
            className="w-full rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down disabled:cursor-not-allowed disabled:opacity-45"
          >
            Save changes
          </button>
        </form>
      </section>
    </Layout>
  )
}

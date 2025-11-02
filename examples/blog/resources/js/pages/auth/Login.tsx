import { Head, Link, usePage } from '@inertiajs/react'
import { useId, useState } from 'react'
import Layout from '../../components/Layout.js'

interface LoginErrors {
  email?: string
  password?: string
  message?: string
}

export default function Login() {
  const page = usePage<{ email?: string; errors?: LoginErrors }>()
  const [email, setEmail] = useState(page.props.email ?? '')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const errors = page.props.errors ?? {}

  const emailId = useId()
  const passwordId = useId()

  return (
    <Layout>
      <Head title="Sign in" />
      <section className="rounded-2xl border border-[#F4B0B0] bg-white/85 p-8 shadow-xl shadow-[#B71C1C]/10 backdrop-blur">
        <h1 className="text-2xl font-semibold text-[#B71C1C]">Sign in</h1>
        <p className="mt-2 text-sm text-[#7A1A1A]">
          Use the demo credentials <span className="font-mono text-[#E35151]">demo@guren.dev / secret</span>
        </p>

        {errors.message && <p className="mt-4 rounded border border-[#B71C1C]/50 bg-[#B71C1C]/10 px-4 py-2 text-sm text-[#7A0F0F]">{errors.message}</p>}

        <form method="post" action="/login" className="mt-6 space-y-4">
          <div>
            <label htmlFor={emailId} className="block text-sm font-medium text-[#8F1111]">
              Email
            </label>
            <input
              id={emailId}
              type="email"
              name="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              className="mt-1 w-full rounded border border-[#F4B0B0] bg-[#FFF5F5] px-3 py-2 text-[#3C0A0A] outline-none transition focus:border-[#B71C1C] focus:ring-2 focus:ring-[#E35151]"
            />
            {errors.email && <p className="mt-1 text-sm text-[#C92A2A]">{errors.email}</p>}
          </div>

          <div>
            <label htmlFor={passwordId} className="block text-sm font-medium text-[#8F1111]">
              Password
            </label>
            <input
              id={passwordId}
              type="password"
              name="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              className="mt-1 w-full rounded border border-[#F4B0B0] bg-[#FFF5F5] px-3 py-2 text-[#3C0A0A] outline-none transition focus:border-[#B71C1C] focus:ring-2 focus:ring-[#E35151]"
            />
            {errors.password && <p className="mt-1 text-sm text-[#C92A2A]">{errors.password}</p>}
          </div>

          <label className="flex items-center gap-2 text-sm text-[#7A1A1A]">
            <input
              type="checkbox"
              name="remember"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="h-4 w-4 rounded border-[#F4B0B0] bg-[#FFF5F5] text-[#B71C1C] focus:ring-[#B71C1C] focus:ring-offset-0"
            />
            Remember me
          </label>

          <button
            type="submit"
            className="w-full rounded bg-[#B71C1C] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#8F1111]"
          >
            Sign in
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-[#7A1A1A]">
          Need an account?{' '}
          <Link href="/register" className="text-[#B71C1C] hover:text-[#7A0F0F]">
            Ask your admin
          </Link>
        </p>
      </section>
    </Layout>
  )
}

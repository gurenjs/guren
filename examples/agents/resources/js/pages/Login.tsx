import { Head, useForm } from '@inertiajs/react'
import { useId } from 'react'

interface Props {
  errors?: { token?: string }
}

export default function Login({ errors = {} }: Props) {
  const form = useForm({ token: '' })
  const tokenId = useId()

  return (
    <div className="min-h-screen bg-g-page font-sans text-g-text">
      <Head title="Sign in" />
      <div className="mx-auto max-w-md px-6 py-[12vh]">
        <section className="rounded-g-card border border-g-line bg-g-panel p-8 shadow-g-card">
          <h1 className="flex items-center gap-3 text-2xl font-bold tracking-tight text-g-heading">
            <span
              aria-hidden
              className="h-6 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]"
            />
            Triager console
          </h1>
          <p className="mt-3 text-sm text-g-text-2">
            Paste the operator token your seed script printed. It is the same bearer credential the
            JSON API takes.
          </p>

          <form
            className="mt-6"
            onSubmit={(event) => {
              event.preventDefault()
              form.post('/login')
            }}
          >
            <label htmlFor={tokenId} className="block text-sm font-bold text-g-heading">
              Operator token
            </label>
            <input
              id={tokenId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={form.data.token}
              onChange={(event) => form.setData('token', event.target.value)}
              className="mt-1 w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 font-mono text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
            />
            <div className="mt-1 min-h-5 text-sm text-g-danger">
              {errors.token ?? form.errors.token ?? ''}
            </div>
            <button
              type="submit"
              disabled={form.processing}
              className="mt-3 w-full rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down disabled:cursor-not-allowed disabled:opacity-45"
            >
              {form.processing ? 'Checking…' : 'Sign in'}
            </button>
          </form>
        </section>
      </div>
    </div>
  )
}

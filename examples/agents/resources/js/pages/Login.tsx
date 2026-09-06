import { Head, useForm } from '@inertiajs/react'
import { useId } from 'react'

interface Props {
  errors?: { token?: string }
}

export default function Login({ errors = {} }: Props) {
  const form = useForm({ token: '' })
  const tokenId = useId()

  return (
    <div className="login">
      <Head title="Sign in" />
      <h1>Triager console</h1>
      <p>
        Paste the operator token your seed script printed. It is the same bearer credential the
        JSON API takes.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          form.post('/login')
        }}
      >
        <label htmlFor={tokenId}>Operator token</label>
        <input
          id={tokenId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={form.data.token}
          onChange={(event) => form.setData('token', event.target.value)}
        />
        <div className="field-error">{errors.token ?? form.errors.token ?? ''}</div>
        <button className="primary" type="submit" disabled={form.processing}>
          {form.processing ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

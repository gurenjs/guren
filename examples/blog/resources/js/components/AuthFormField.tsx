import { useId } from 'react'

interface AuthFormFieldProps {
  label: string
  name: string
  type?: string
  autoComplete?: string
  value: string
  onChange: (value: string) => void
  error?: string | string[]
}

export default function AuthFormField({ label, name, type = 'text', autoComplete, value, onChange, error }: AuthFormFieldProps) {
  const id = useId()
  const message = Array.isArray(error) ? error[0] : error

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-stone-700">
        {label}
      </label>
      <div className="mt-2">
        <input
          id={id}
          name={name}
          type={type}
          autoComplete={autoComplete}
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="block w-full rounded-md border-0 py-2.5 px-3 text-stone-900 shadow-sm ring-1 ring-inset ring-stone-200 placeholder:text-stone-300 focus:ring-2 focus:ring-inset focus:ring-stone-900 sm:text-sm sm:leading-6"
        />
      </div>
      {message && <p className="mt-2 text-sm text-red-600">{message}</p>}
    </div>
  )
}

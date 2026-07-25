import type { PropsWithChildren, ReactNode } from 'react'

interface AuthCardProps {
  title: string
  subtitle?: ReactNode
}

export default function AuthCard({ title, subtitle, children }: PropsWithChildren<AuthCardProps>) {
  return (
    <div className="w-full max-w-md space-y-8">
      <div className="text-center">
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-stone-900">{title}</h2>
        {subtitle ? <p className="mt-2 text-sm text-stone-400">{subtitle}</p> : null}
      </div>
      <div className="rounded-lg bg-white px-6 py-8 shadow-sm sm:px-10">{children}</div>
    </div>
  )
}

const PROVIDERS = [
  { id: 'github', label: 'GitHub' },
  { id: 'google', label: 'Google' },
] as const

export default function OAuthButtons() {
  return (
    <div className="mt-6">
      <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-stone-400">
        <span className="h-px flex-1 bg-stone-200" />
        Or continue with
        <span className="h-px flex-1 bg-stone-200" />
      </div>
      <div className="mt-4 space-y-3">
        {PROVIDERS.map((provider) => (
          <a
            key={provider.id}
            href={`/auth/${provider.id}`}
            className="flex w-full items-center justify-center rounded-md border border-stone-200 bg-white px-4 py-2.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50"
          >
            Continue with {provider.label}
          </a>
        ))}
      </div>
    </div>
  )
}

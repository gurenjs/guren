import type { ReactNode } from 'react'

interface FeatureCardProps {
  icon: ReactNode
  title: string
  body: string
}

export function FeatureCard({ icon, title, body }: FeatureCardProps) {
  return (
    <article className="group rounded-2xl border border-white/10 bg-white/5 p-6 transition hover:-translate-y-1 hover:border-crimson-500/40 hover:shadow-[0_20px_40px_rgba(0,0,0,0.35)]">
      <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-crimson-500/10 text-crimson-400 transition group-hover:bg-crimson-500/20">
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-crimson-200">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-white/70">{body}</p>
    </article>
  )
}

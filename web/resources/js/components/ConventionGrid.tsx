import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { InlineCode } from './InlineCode.js'

/** One animated step: the vg-* class names the keyframes in app.css, delay is seconds. */
function step(delay: number): CSSProperties {
  return { animationDelay: `${delay}s` }
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <div
      aria-hidden
      className="relative flex h-36 flex-col justify-center overflow-hidden rounded-md border border-white/10 bg-ink px-4 font-mono text-[12px] leading-relaxed text-smoke"
    >
      {children}
    </div>
  )
}

function Status({ code, delay }: { code: string; delay: number }) {
  return (
    <span
      className="vg-pop rounded border border-crimson-400/40 bg-crimson-900/40 px-1.5 text-[11px] font-medium text-crimson-300"
      style={step(delay)}
    >
      {code}
    </span>
  )
}

function ControllerAnswers() {
  const rows = [
    ['validateBody()', '422'],
    ['findOrFail()', '404'],
    ['userOrFail()', '401'],
  ] as const
  return (
    <Panel>
      {rows.map(([call, code], i) => (
        <div key={call} className="flex items-center gap-3 py-0.5">
          <span className="text-crimson-50">{call}</span>
          <span className="h-px flex-1 border-t border-dashed border-white/15" />
          <Status code={code} delay={0.3 + i * 0.35} />
        </div>
      ))}
    </Panel>
  )
}

function RenameBreaksBuild() {
  return (
    <Panel>
      <p className="text-[11px] text-smoke/60">routes/web.ts</p>
      <p>
        .name(&apos;posts.
        <span className="relative inline-block">
          <span className="vg-out text-crimson-50" style={step(0.4)}>
            show
          </span>
          <span className="vg-in absolute left-0 top-0 text-crimson-50" style={step(0.55)}>
            view
          </span>
        </span>
        &apos;)
      </p>
      <p className="mt-2 text-[11px] text-smoke/60">pages/posts/Index.tsx</p>
      <p>
        route(
        <span className="relative text-crimson-50">
          &apos;posts.show&apos;
          <span
            className="vg-grow absolute inset-x-0 -bottom-0.5 h-[2px] origin-left bg-[repeating-linear-gradient(135deg,#fc6d6d_0_2px,transparent_2px_4px)]"
            style={step(1)}
          />
        </span>
        )
      </p>
      <p className="vg-in mt-2 text-crimson-400" style={step(1.3)}>
        ✗ tsc: no route &apos;posts.show&apos;
      </p>
    </Panel>
  )
}

function QueryToSql() {
  return (
    <Panel>
      <p className="text-crimson-50">Post.where(&apos;published&apos;, true).get()</p>
      <p className="vg-in my-1.5 text-smoke/60" style={step(0.4)}>
        ↓ drizzle
      </p>
      <p className="vg-reveal text-foam" style={step(0.6)}>
        select … from posts where published = ?
      </p>
    </Panel>
  )
}

function PropsHandOff() {
  return (
    <Panel>
      <div className="flex items-center justify-between">
        <span className="shrink-0 rounded border border-white/15 px-2 py-1 text-crimson-50">PostController</span>
        <span className="relative mx-1 h-px min-w-24 flex-1 bg-white/15">
          <span
            className="vg-slide absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-crimson-900 px-1.5 text-[11px] text-crimson-300"
            style={step(0.3)}
          >
            {'{ posts }'}
          </span>
        </span>
        <span className="vg-light shrink-0 rounded border border-white/15 px-2 py-1 text-crimson-50" style={step(1.1)}>
          Index.tsx
        </span>
      </div>
      <p className="vg-in mt-4 text-center text-[11px] text-smoke/70" style={step(1.2)}>
        props: Data.Post[], no fetch in between
      </p>
    </Panel>
  )
}

const BATTERIES = ['auth', 'queue', 'mail', 'cache', 'events', 'schedule', 'storage', 'i18n']

function Batteries() {
  return (
    <Panel>
      <div className="grid grid-cols-4 gap-2">
        {BATTERIES.map((name, i) => (
          <span
            key={name}
            className="vg-light rounded border border-white/15 py-1 text-center text-crimson-50"
            style={step(0.2 + i * 0.12)}
          >
            {name}
          </span>
        ))}
      </div>
    </Panel>
  )
}

function PrototypeToController() {
  return (
    <Panel>
      <div className="rounded border border-white/15 p-3">
        <div className="mb-2.5 flex items-center justify-between text-[11px]">
          <span className="text-smoke/70">posts/Index</span>
          <span className="relative">
            <span className="vg-out rounded bg-white/10 px-1.5 text-smoke" style={step(1.3)}>
              fixture
            </span>
            <span
              className="vg-in absolute right-0 top-0 rounded bg-crimson-900 px-1.5 text-crimson-300"
              style={step(1.45)}
            >
              controller
            </span>
          </span>
        </div>
        {[80, 62, 71].map((width, i) => (
          <span
            key={width}
            className="vg-grow mt-1.5 block h-1.5 origin-left rounded-full bg-crimson-50/25"
            style={{ ...step(0.25 + i * 0.2), width: `${width}%` }}
          />
        ))}
      </div>
    </Panel>
  )
}

const FEATURES: Array<{ title: string; body: ReactNode; Visual: () => ReactNode }> = [
  {
    title: 'Controllers you already know',
    body: (
      <>
        <InlineCode>validateBody()</InlineCode>, <InlineCode>findOrFail()</InlineCode> and{' '}
        <InlineCode>userOrFail()</InlineCode> send the error response themselves.
      </>
    ),
    Visual: ControllerAnswers,
  },
  {
    title: 'Types from route to React',
    body: 'Rename a route and every page that links to the old name fails to compile.',
    Visual: RenameBreaksBuild,
  },
  {
    title: 'Drizzle models, Eloquent manners',
    body: 'Eloquent-style queries, run by Drizzle ORM.',
    Visual: QueryToSql,
  },
  {
    title: 'No API layer to babysit',
    body: 'Inertia passes controller props straight to React.',
    Visual: PropsHandOff,
  },
  {
    title: 'Batteries actually included',
    body: 'Auth, queues, mail, cache and more ship with the framework.',
    Visual: Batteries,
  },
  {
    title: 'Prototype before the backend',
    body: 'Build the pages on fixtures, show them, then write the controllers.',
    Visual: PrototypeToController,
  },
]

/**
 * The six conventions, each with a small panel that plays once when the grid
 * comes into view. Server output, and reduced motion, show the end state.
 */
export function ConventionGrid() {
  const ref = useRef<HTMLDivElement>(null)
  const [armed, setArmed] = useState(false)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    const grid = ref.current
    if (!grid || typeof IntersectionObserver === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    setArmed(true)
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        observer.disconnect()
        setPlaying(true)
      },
      { threshold: 0.25 },
    )
    observer.observe(grid)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      data-armed={armed || undefined}
      data-play={playing || undefined}
      className="vg mt-14 grid grid-cols-1 gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-3"
    >
      {FEATURES.map(({ title, body, Visual }) => (
        <div key={title}>
          <Visual />
          <h3 className="mt-5 text-lg font-bold leading-snug text-crimson-50">{title}</h3>
          <p className="mt-2 text-[0.9375rem] leading-[1.6] text-smoke">{body}</p>
        </div>
      ))}
    </div>
  )
}

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
      className="vg-pop rounded border border-crimson-400/40 bg-crimson-900/40 px-1.5 text-[11px] text-crimson-300"
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
            className="vg-grow absolute inset-x-0 -bottom-0.5 h-[2px] origin-left bg-[repeating-linear-gradient(135deg,var(--color-crimson-400)_0_2px,transparent_2px_4px)]"
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
        <span className="vg-light shrink-0 rounded border px-2 py-1 text-crimson-50" style={step(1.1)}>
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
            className="vg-light rounded border py-1 text-center text-crimson-50"
            style={step(0.2 + i * 0.12)}
          >
            {name}
          </span>
        ))}
      </div>
    </Panel>
  )
}

/** The same page fed first by the fixture, then by the controller that replaces it. */
function PrototypeToController() {
  return (
    <Panel>
      <div className="flex items-center">
        <div className="flex shrink-0 flex-col gap-5">
          <span className="vg-dim block" style={step(1.75)}>
            <span className="vg-in block rounded border border-dashed border-white/30 px-2 py-1 text-smoke" style={step(0.2)}>
              fixture
            </span>
          </span>
          <span className="vg-in block rounded border border-white/15 px-2 py-1 text-crimson-50" style={step(1.2)}>
            PostController
          </span>
        </div>
        <svg viewBox="0 0 40 74" className="h-[74px] w-10 shrink-0 text-crimson-300" fill="none" stroke="currentColor" strokeWidth="1.2">
          <g className="vg-dim" style={step(1.75)}>
            <path className="vg-draw" pathLength={1} d="M0 13 C 22 13, 18 37, 40 37" style={step(0.35)} />
          </g>
          <path className="vg-draw" pathLength={1} d="M0 61 C 22 61, 18 37, 40 37" style={step(1.35)} />
        </svg>
        <div className="vg-light min-w-0 flex-1 rounded border p-2.5" style={step(1.75)}>
          <p className="truncate text-[11px] text-smoke/70">posts/Index</p>
          {[88, 64, 76].map((width, i) => (
            <span
              key={width}
              className="vg-grow mt-1.5 block h-1.5 origin-left rounded-full bg-crimson-50/30"
              style={{ ...step(0.7 + i * 0.12), width: `${width}%` }}
            />
          ))}
        </div>
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

type Phase = 'armed' | 'play'

/**
 * The six conventions, each with a small panel that plays once when it comes
 * into view. Server output, reduced motion, and a panel already on screen when
 * the page loads all show the end state.
 */
export function ConventionGrid() {
  const items = useRef<Array<HTMLDivElement | null>>([])
  const [phases, setPhases] = useState<Array<Phase | undefined>>([])

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const seen = new Set<Element>()
    const observer = new IntersectionObserver(
      (entries) => {
        const changes = new Map<number, Phase>()
        for (const entry of entries) {
          const first = !seen.has(entry.target)
          seen.add(entry.target)
          const index = items.current.indexOf(entry.target as HTMLDivElement)
          if (entry.isIntersecting) {
            observer.unobserve(entry.target)
            // A panel visible at its first report keeps its finished state
            // instead of blanking out to replay.
            if (!first) changes.set(index, 'play')
          } else if (first) {
            changes.set(index, 'armed')
          }
        }
        if (changes.size === 0) return
        setPhases((previous) => {
          const next = [...previous]
          changes.forEach((phase, index) => {
            next[index] = phase
          })
          return next
        })
      },
      { threshold: 0.5 },
    )
    items.current.forEach((item) => item && observer.observe(item))
    return () => observer.disconnect()
  }, [])

  return (
    <div className="vg mt-14 grid grid-cols-1 gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
      {FEATURES.map(({ title, body, Visual }, index) => (
        <div
          key={title}
          ref={(item) => {
            items.current[index] = item
          }}
          data-phase={phases[index]}
        >
          <Visual />
          <h3 className="mt-5 text-lg font-bold leading-snug text-crimson-50">{title}</h3>
          <p className="mt-2 text-[0.9375rem] leading-[1.6] text-smoke">{body}</p>
        </div>
      ))}
    </div>
  )
}

import { Link, router } from '@inertiajs/react'
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { pageTitle } from '../../../config/site.js'
import { CopyBlock, CopyCommand } from '../components/CopyCommand.js'
import { Footer } from '../components/Footer.js'
import { Header } from '../components/Header.js'
import { InlineCode } from '../components/InlineCode.js'
import { Seo } from '../components/Seo.js'
import {
  AGENT_DETAILS,
  AGENTS,
  DEFAULT_PROJECT_NAME,
  buildAgentPrompt,
  buildCreateCommand,
  buildNextSteps,
  hasRenderingMode,
  isValidProjectName,
  offersAuth,
  startOptionsToQuery,
  usesDatabaseContainer,
  type Agent,
  type Blueprint,
  type Database,
  type RenderingMode,
  type StartOptions,
} from '../lib/start-command.js'

interface Props {
  initial: StartOptions
}

const BLUEPRINT_CHOICES: Array<{ value: Blueprint; label: string; detail: string }> = [
  { value: 'default', label: 'Full-stack', detail: 'React pages through Inertia, ready for your first resource.' },
  { value: 'blog', label: 'Blog', detail: 'Posts, sign-in and a seeded demo account to read and change.' },
  { value: 'api', label: 'API only', detail: 'JSON routes. No React and no frontend build.' },
  { value: 'worker', label: 'Full-stack with jobs', detail: 'Adds a queue, events, a cache and scheduled tasks.' },
]

const MODE_CHOICES: Array<{ value: RenderingMode; label: string; detail: string }> = [
  { value: 'ssr', label: 'SSR', detail: 'The server renders HTML, then React takes over.' },
  { value: 'spa', label: 'SPA', detail: 'React renders in the browser. One build fewer.' },
]

const DATABASE_CHOICES: Array<{ value: Database; label: string; detail: string }> = [
  { value: 'sqlite', label: 'SQLite', detail: 'Nothing to install. The database is a file.' },
  { value: 'postgres', label: 'PostgreSQL', detail: 'Runs in a Docker container the app sets up.' },
  { value: 'mysql', label: 'MySQL', detail: 'Runs in a Docker container the app sets up.' },
]

const TABS = ['command', 'agent'] as const
type Tab = (typeof TABS)[number]

const FIELDSET = 'border-t border-white/10 pt-6'
const LEGEND = 'text-sm font-bold uppercase tracking-[0.08em] text-crimson-300'

function choiceClass(selected: boolean, disabled = false): string {
  const base =
    'flex cursor-pointer flex-col gap-1 rounded-md border px-4 py-3 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-crimson-300'
  if (disabled) return `${base} cursor-not-allowed border-white/10 opacity-50`
  return selected
    ? `${base} border-crimson-400 bg-crimson-900/40`
    : `${base} border-white/15 hover:border-white/35`
}

function RadioGroup<T extends string>({
  name,
  legend,
  choices,
  value,
  onChange,
  columns,
}: {
  name: string
  legend: string
  choices: Array<{ value: T; label: string; detail: string }>
  value: T
  onChange: (value: T) => void
  columns: string
}) {
  return (
    <fieldset className={FIELDSET}>
      <legend className={LEGEND}>{legend}</legend>
      <div className={`mt-4 grid gap-2 ${columns}`}>
        {choices.map((choice) => (
          <label key={choice.value} className={choiceClass(value === choice.value)}>
            <span className="flex items-center gap-2 font-bold text-crimson-50">
              <input
                type="radio"
                name={name}
                value={choice.value}
                checked={value === choice.value}
                onChange={() => onChange(choice.value)}
                className="accent-crimson-500"
              />
              {choice.label}
            </span>
            <span className="text-sm leading-snug text-smoke">{choice.detail}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function Checkbox({
  checked,
  onChange,
  label,
  detail,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  detail: string
}) {
  return (
    <label className={choiceClass(checked)}>
      <span className="flex items-center gap-2 font-bold text-crimson-50">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="accent-crimson-500"
        />
        {label}
      </span>
      <span className="text-sm leading-snug text-smoke">{detail}</span>
    </label>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4">
      <span
        aria-hidden
        className="flex size-7 items-center justify-center rounded-full border border-crimson-400/60 font-mono text-sm text-crimson-300"
      >
        {n}
      </span>
      <div>
        <h3 className="font-bold leading-7 text-crimson-50">{title}</h3>
        <div className="mt-3 space-y-3 text-[0.9375rem] leading-[1.65] text-smoke">{children}</div>
      </div>
    </li>
  )
}

function Prerequisites({ options }: { options: StartOptions }) {
  return (
    <p>
      Needs{' '}
      <a href="https://bun.sh" target="_blank" rel="noopener noreferrer" className="text-crimson-300 underline">
        Bun
      </a>{' '}
      1.4.2 or later
      {usesDatabaseContainer(options.db) ? <>, and Docker running for {options.db === 'mysql' ? 'MySQL' : 'PostgreSQL'}</> : null}.
    </p>
  )
}

function CommandPanel({ options }: { options: StartOptions }) {
  return (
    <ol className="space-y-8">
      <Step n={1} title="Create the app">
        <Prerequisites options={options} />
        <CopyCommand command={buildCreateCommand(options)} />
      </Step>
      <Step n={2} title="Run it">
        <CopyBlock text={buildNextSteps(options).join('\n')} label="the commands to run the app" />
        <p>
          Then open <InlineCode>http://localhost:3333</InlineCode>.
          {options.blueprint === 'blog' ? <> Sign in as <InlineCode>demo@example.com</InlineCode> with the password <InlineCode>secret</InlineCode>.</> : null}
        </p>
      </Step>
      <Step n={3} title="Build something">
        <p>
          <Link href="/docs/tutorials/00-overview" className="text-crimson-300 underline">
            The tutorial
          </Link>{' '}
          turns this app into a blog, one concept per chapter. The{' '}
          <Link href="/docs/guides/getting-started" className="text-crimson-300 underline">
            quickstart
          </Link>{' '}
          covers environment variables, generators and production builds.
        </p>
      </Step>
    </ol>
  )
}

function AgentPanel({ options }: { options: StartOptions }) {
  const [agent, setAgent] = useState<Agent>(options.agents[0] ?? 'claude')
  const [goal, setGoal] = useState('')
  const active = options.agents.includes(agent) ? agent : options.agents[0]

  if (!active) {
    return (
      <p className="text-[0.9375rem] leading-[1.65] text-smoke">
        Choose at least one coding agent on the left. The app then ships the instructions, skills and
        checks that agent reads.
      </p>
    )
  }

  const detail = AGENT_DETAILS[active]

  return (
    <ol className="space-y-8">
      <Step n={1} title="Create the app">
        <Prerequisites options={options} />
        <CopyCommand command={buildCreateCommand(options)} />
      </Step>
      <Step n={2} title={`Start ${detail.label} inside the app`}>
        {options.agents.length > 1 ? (
          <div role="radiogroup" aria-label="Agent to start" className="flex flex-wrap gap-2">
            {options.agents.map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={a === active}
                onClick={() => setAgent(a)}
                className={`rounded-full border px-3 py-1 text-sm transition ${
                  a === active ? 'border-crimson-400 bg-crimson-900/40 text-crimson-50' : 'border-white/15 text-smoke hover:border-white/35'
                }`}
              >
                {AGENT_DETAILS[a].label}
              </button>
            ))}
          </div>
        ) : null}
        <CopyBlock text={[`cd ${options.name}`, detail.launch].join('\n')} label={`the commands to start ${detail.label}`} />
        <p>
          Start it from the new directory, not from the one you ran the command in: that is where it
          finds <InlineCode>{detail.entry}</InlineCode> and the rest of the harness the scaffolder wrote.
          {detail.where ? <> Paste the prompt into {detail.where}.</> : null}
        </p>
      </Step>
      <Step n={3} title="Send this prompt">
        <label className="block">
          <span className="text-sm text-smoke">What do you want to build first? (optional)</span>
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            rows={2}
            placeholder="A page where members list the books they have read"
            className="mt-2 w-full rounded-md border border-white/15 bg-ink px-3 py-2 font-home text-[0.9375rem] text-crimson-50 placeholder:text-smoke/50 focus-visible:outline-2 focus-visible:outline-crimson-300"
          />
        </label>
        <CopyBlock text={buildAgentPrompt(options, active, goal)} label="the prompt" prompt />
        <p>
          The agent checks the app with the same gate CI runs, and asks before it writes code. The{' '}
          <Link href="/docs/agent-course/00-overview" className="text-crimson-300 underline">
            agent course
          </Link>{' '}
          shows how to take a feature from plan to merged commits.
        </p>
      </Step>
    </ol>
  )
}

export default function Start({ initial }: Props) {
  const [options, setOptions] = useState<StartOptions>(initial)
  const [nameInput, setNameInput] = useState(initial.name)
  const [tab, setTab] = useState<Tab>('command')

  const update = (patch: Partial<StartOptions>) => setOptions((current) => ({ ...current, ...patch }))

  useEffect(() => {
    const query = startOptionsToQuery(options)
    // Through Inertia, not history.replaceState: Back restores the page from
    // Inertia's own record, which a bare URL change leaves at the first visit.
    router.replace({
      url: `/start${query ? `?${query}` : ''}`,
      props: (props: Record<string, unknown>) => ({ ...props, initial: options }),
      preserveState: true,
      preserveScroll: true,
    })
  }, [options])

  const changeName = (value: string) => {
    setNameInput(value)
    update({ name: isValidProjectName(value) ? value : DEFAULT_PROJECT_NAME })
  }

  const toggleAgent = (agent: Agent, on: boolean) => {
    const next = on ? [...options.agents, agent] : options.agents.filter((a) => a !== agent)
    update({ agents: AGENTS.filter((a) => next.includes(a)) })
  }

  const moveTab = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key]
    if (!step) return
    event.preventDefault()
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]!
    setTab(next)
    document.getElementById(`start-tab-${next}`)?.focus()
  }

  const nameInvalid = !isValidProjectName(nameInput)

  return (
    <>
      <Seo
        title={pageTitle('Start a new app')}
        description="Choose a starter, a database and a rendering mode, then copy the create-guren-app command or a prompt for your coding agent."
        path="/start"
      />
      <div className="min-h-dvh bg-crimson-950 font-home text-crimson-50 antialiased">
        <Header variant="home" />

        <main className="mx-auto max-w-6xl px-6 pb-24 pt-14 md:pt-20">
          <span aria-hidden className="block h-[3px] w-8 bg-gradient-to-r from-ember to-crimson-700" />
          <h1 className="mt-5 text-balance text-[2.25rem] font-bold leading-[1.08] tracking-[-0.03em] md:text-[3rem]">
            Start a new app
          </h1>
          <p className="mt-5 max-w-[38rem] text-lg leading-[1.65] text-smoke">
            Pick what the app needs and the command updates as you go. The defaults already work:
            SQLite needs no setup.
          </p>
          <a href="#start-output" className="mt-4 inline-block text-crimson-300 underline lg:hidden">
            Skip to the command
          </a>

          <div className="mt-12 grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16">
            <form className="space-y-8" onSubmit={(event) => event.preventDefault()}>
              <label className="block">
                <span className={LEGEND}>Project name</span>
                <input
                  type="text"
                  value={nameInput}
                  onChange={(event) => changeName(event.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  aria-invalid={nameInvalid}
                  aria-describedby="start-name-help"
                  className="mt-3 w-full rounded-md border border-white/15 bg-ink px-4 py-3 font-mono text-crimson-50 focus-visible:outline-2 focus-visible:outline-crimson-300"
                />
                <span id="start-name-help" className={`mt-2 block text-sm ${nameInvalid ? 'text-crimson-300' : 'text-smoke'}`}>
                  {nameInvalid
                    ? `Use lowercase letters, digits, dots, dashes and underscores. Using "${DEFAULT_PROJECT_NAME}" until then.`
                    : 'The directory the app is created in.'}
                </span>
              </label>

              <RadioGroup
                name="blueprint"
                legend="Starter"
                choices={BLUEPRINT_CHOICES}
                value={options.blueprint}
                onChange={(blueprint) => update({ blueprint })}
                columns="sm:grid-cols-2"
              />

              {hasRenderingMode(options.blueprint) ? (
                <RadioGroup
                  name="mode"
                  legend="Rendering"
                  choices={MODE_CHOICES}
                  value={options.mode}
                  onChange={(mode) => update({ mode })}
                  columns="sm:grid-cols-2"
                />
              ) : null}

              <RadioGroup
                name="db"
                legend="Database"
                choices={DATABASE_CHOICES}
                value={options.db}
                onChange={(db) => update({ db })}
                columns="sm:grid-cols-3"
              />

              {offersAuth(options.blueprint) ? (
                <fieldset className={FIELDSET}>
                  <legend className={LEGEND}>Authentication</legend>
                  <div className="mt-4">
                    <Checkbox
                      checked={options.auth}
                      onChange={(auth) => update({ auth })}
                      label="Add sign-in"
                      detail="Sign-up and sign-in pages, sessions and a users table."
                    />
                  </div>
                </fieldset>
              ) : null}

              <fieldset className={FIELDSET}>
                <legend className={LEGEND}>Coding agents</legend>
                <p className="mt-2 text-sm text-smoke">
                  The app ships instructions, skills and checks for each agent you pick.
                </p>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {AGENTS.map((agent) => (
                    <label key={agent} className={choiceClass(options.agents.includes(agent))}>
                      <span className="flex items-center gap-2 font-bold text-crimson-50">
                        <input
                          type="checkbox"
                          checked={options.agents.includes(agent)}
                          onChange={(event) => toggleAgent(agent, event.target.checked)}
                          className="accent-crimson-500"
                        />
                        {AGENT_DETAILS[agent].label}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className={FIELDSET}>
                <legend className={LEGEND}>Git</legend>
                <div className="mt-4">
                  <Checkbox
                    checked={options.git}
                    onChange={(git) => update({ git })}
                    label="Initialize a repository"
                    detail="Runs git init and makes a first commit of the scaffold."
                  />
                </div>
              </fieldset>
            </form>

            <section id="start-output" aria-label="How to start" className="scroll-mt-24 lg:sticky lg:top-24 lg:self-start">
              <div role="tablist" aria-label="How to start" onKeyDown={moveTab} className="flex gap-1 border-b border-white/15">
                {TABS.map((t) => (
                  <button
                    key={t}
                    id={`start-tab-${t}`}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    aria-controls={`start-panel-${t}`}
                    tabIndex={tab === t ? 0 : -1}
                    onClick={() => setTab(t)}
                    className={`-mb-px border-b-2 px-4 py-3 text-[0.9375rem] font-bold transition ${
                      tab === t ? 'border-crimson-400 text-crimson-50' : 'border-transparent text-smoke hover:text-crimson-50'
                    }`}
                  >
                    {t === 'command' ? 'Run it yourself' : 'With a coding agent'}
                  </button>
                ))}
              </div>
              <div id={`start-panel-${tab}`} role="tabpanel" aria-labelledby={`start-tab-${tab}`} className="pt-8">
                {tab === 'command' ? <CommandPanel options={options} /> : <AgentPanel options={options} />}
              </div>
            </section>
          </div>
        </main>

        <Footer variant="home" />
      </div>
    </>
  )
}

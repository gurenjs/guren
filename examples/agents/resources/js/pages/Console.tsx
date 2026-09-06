import { Head, router } from '@inertiajs/react'
import { useState, type ReactNode } from 'react'

import type { TriagerState } from '@/app/Agents/Triager'
import type { ApprovalView } from '@/app/Services/approvals'
import type { TicketView } from '@/app/Services/tickets'

/** The five sweep counts, in the order the panel's 5-column grid expects. */
const SWEEP_COUNTS = ['stale', 'asked', 'closed', 'refused', 'deferred'] as const

const PANEL_CLASS = 'rounded-g-card border border-g-line bg-g-panel p-5 shadow-g-card'
const PANEL_HEADING_CLASS = 'mb-3 font-mono text-xs tracking-[0.14em] uppercase text-g-text-2'
const DISABLED_CLASS = 'disabled:cursor-not-allowed disabled:opacity-45'
const CHIP_CLASS = 'shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase'
const META_CLASS = 'block text-xs break-words text-g-text-2'
const EMPTY_CLASS = 'py-1.5 text-sm text-g-muted italic'

/** `agentApprovalStatusAt` derives a status, so a value outside this map is reachable. */
const CHIP_TONES: Record<string, string> = {
  open: 'border-g-warn-chip bg-g-warn-tint text-g-warn',
  closed: 'border-g-ok-chip bg-g-ok-tint text-g-ok',
  approved: 'border-g-ok-chip bg-g-ok-tint text-g-ok',
  rejected: 'border-g-danger-chip bg-g-danger-tint text-g-danger',
}
const NEUTRAL_CHIP_TONE = 'border-g-line-strong text-g-muted'

const ALERT_TONES = {
  danger: 'border-g-danger-chip bg-g-danger-tint text-g-danger',
  warn: 'border-g-warn-chip bg-g-warn-tint text-g-warn',
}

interface Props {
  operator: string
  tickets: TicketView[]
  approvals: { pending: ApprovalView[]; resolved: ApprovalView[] }
  report: TriagerState | null
  agentNote: string | null
  errors?: { approval?: string; sweep?: string }
}

function clock(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

/** `tickets.close` carries the ticket id, and it is the only input worth a column. */
function subject(approval: ApprovalView): string {
  const id = approval.input['id']
  return typeof id === 'number' || typeof id === 'string' ? `ticket #${id}` : 'no subject'
}

function ApprovalTitle({ approval }: { approval: ApprovalView }) {
  return (
    <>
      <code className="font-mono text-sm">{approval.tool}</code> —{' '}
      <span className="font-mono text-sm">{subject(approval)}</span>
    </>
  )
}

function Chip({ status }: { status: string }) {
  return <span className={`${CHIP_CLASS} ${CHIP_TONES[status] ?? NEUTRAL_CHIP_TONE}`}>{status}</span>
}

function Alert({ tone = 'danger', children }: { tone?: 'danger' | 'warn'; children: ReactNode }) {
  return (
    <div className={`mb-4 rounded-g-ctl border px-4 py-2.5 text-sm ${ALERT_TONES[tone]}`}>
      {children}
    </div>
  )
}

/** `min-w-0` or the principal key — one unbroken token — sets the column's
    floor and pushes the buttons out of the panel. */
function Row({
  title,
  meta,
  mono = false,
  inline = false,
  children,
}: {
  title: ReactNode
  meta: ReactNode
  mono?: boolean
  inline?: boolean
  children?: ReactNode
}) {
  return (
    <div
      className={`flex items-center gap-x-3 gap-y-2 border-t border-g-line py-2.5 first-of-type:border-t-0 ${inline ? '' : 'flex-wrap'}`}
    >
      <div className={inline ? 'min-w-0 grow' : 'min-w-0 grow basis-full'}>
        <span className="block break-words text-g-text">{title}</span>
        <span className={mono ? `${META_CLASS} font-mono` : META_CLASS}>{meta}</span>
      </div>
      {children}
    </div>
  )
}

export default function Console({
  operator,
  tickets,
  approvals,
  report,
  agentNote,
  errors = {},
}: Props) {
  const [busy, setBusy] = useState<string | null>(null)

  const send = (key: string, url: string) => {
    setBusy(key)
    router.post(url, {}, { preserveScroll: true, onFinish: () => setBusy(null) })
  }

  const open = tickets.filter((ticket) => ticket.status === 'open')
  const closed = tickets.filter((ticket) => ticket.status === 'closed')
  const sweep = report?.lastSweep

  return (
    <div className="min-h-screen bg-g-page font-sans text-g-text">
      <Head title="Triager console" />

      <div className="mx-auto max-w-[1140px] px-6 pt-8 pb-16">
        <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-g-line pb-4">
          <h1 className="flex items-center gap-3 text-lg font-bold tracking-tight text-g-heading">
            <span
              aria-hidden
              className="h-6 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]"
            />
            Triager console
          </h1>
          <span className="text-sm text-g-text-2">
            signed in as <span className="font-mono text-xs">{operator}</span>
          </span>
          <span className="grow" />
          <button
            className={`rounded-g-ctl bg-g-accent px-4 py-1.5 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down ${DISABLED_CLASS}`}
            disabled={busy !== null || agentNote !== null}
            onClick={() => send('sweep', '/console/sweep')}
          >
            {busy === 'sweep' ? 'Sweeping…' : 'Run sweep'}
          </button>
          <button
            className={`rounded-g-ctl border border-g-line-strong px-3 py-1.5 text-sm font-bold text-g-text transition hover:border-g-muted ${DISABLED_CLASS}`}
            disabled={busy !== null}
            onClick={() => send('logout', '/logout')}
          >
            Sign out
          </button>
        </div>

        {errors.approval ? <Alert>{errors.approval}</Alert> : null}
        {errors.sweep ? <Alert>{errors.sweep}</Alert> : null}
        {agentNote ? <Alert tone="warn">{agentNote}</Alert> : null}

        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
          <section className={PANEL_CLASS}>
            <h2 className={PANEL_HEADING_CLASS}>Pending approvals</h2>
            {approvals.pending.length === 0 ? (
              <p className={EMPTY_CLASS}>Nothing waiting on a human.</p>
            ) : (
              approvals.pending.map((approval) => (
                <Row
                  key={approval.id}
                  title={<ApprovalTitle approval={approval} />}
                  meta={
                    <>
                      asked by {approval.principal} · expires {clock(approval.expiresAt)}
                    </>
                  }
                >
                  <button
                    className={`rounded-g-ctl border border-g-ok-chip px-3 py-1.5 text-sm font-bold text-g-ok transition hover:bg-g-ok-tint ${DISABLED_CLASS}`}
                    disabled={busy !== null}
                    onClick={() => send(approval.id, `/console/approvals/${approval.id}/approve`)}
                  >
                    Approve
                  </button>
                  <button
                    className={`rounded-g-ctl border border-g-danger-chip px-3 py-1.5 text-sm font-bold text-g-danger transition hover:bg-g-danger-tint ${DISABLED_CLASS}`}
                    disabled={busy !== null}
                    onClick={() => send(approval.id, `/console/approvals/${approval.id}/reject`)}
                  >
                    Reject
                  </button>
                </Row>
              ))
            )}
          </section>

          <section className={PANEL_CLASS}>
            <h2 className={PANEL_HEADING_CLASS}>Agent report</h2>
            {report === null ? (
              <p className={EMPTY_CLASS}>No agent to ask.</p>
            ) : (
              <>
                {/* A grid, not a flex row: the five sweep counts belong on one line,
                    and wrapping one of them away reads as a sixth section. */}
                <div className="mb-1 grid grid-cols-5 gap-2">
                  {SWEEP_COUNTS.map((key) => (
                    <div key={key}>
                      <div className="font-mono text-2xl tabular-nums text-g-heading">
                        {sweep?.[key] ?? 0}
                      </div>
                      <div className="font-mono text-[10px] tracking-wide uppercase text-g-muted">
                        {key}
                      </div>
                    </div>
                  ))}
                </div>
                <Row title="Last sweep" mono meta={clock(report.lastRunAt)} />
                {sweep?.error ? <Alert>{sweep.error}</Alert> : null}
                <Row
                  title="Parked on a human"
                  mono
                  meta={
                    Object.keys(report.parked).length === 0
                      ? 'none'
                      : Object.entries(report.parked)
                          .map(([id, until]) => `#${id} until ${clock(until)}`)
                          .join(' · ')
                  }
                />
                <Row
                  title="Declined by a human"
                  mono
                  meta={
                    report.declined.length === 0
                      ? 'none'
                      : report.declined.map((id) => `#${id}`).join(' · ')
                  }
                />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-g-line py-2.5">
                  <div className="min-w-0 grow basis-full">
                    <span className="block break-words text-g-text">Settled</span>
                    {report.settled.length === 0 ? (
                      <span className={META_CLASS}>none yet</span>
                    ) : (
                      report.settled
                        .slice()
                        .reverse()
                        .map((record) => (
                          <span className={`${META_CLASS} font-mono`} key={record.requestId}>
                            <code>{record.tool}</code> {record.status} · retry{' '}
                            {record.retried ?? 'not run'} · {clock(record.at)}
                          </span>
                        ))
                    )}
                  </div>
                </div>
              </>
            )}
          </section>

          <section className={PANEL_CLASS}>
            <h2 className={PANEL_HEADING_CLASS}>
              Tickets — {open.length} open, {closed.length} closed
            </h2>
            {tickets.map((ticket) => (
              <Row
                key={ticket.id}
                inline
                title={
                  <>
                    <span className="font-mono text-sm">#{ticket.id}</span> {ticket.title}
                  </>
                }
                meta={<>opened {clock(ticket.createdAt)}</>}
              >
                <Chip status={ticket.status} />
              </Row>
            ))}
            {tickets.length === 0 ? <p className={EMPTY_CLASS}>No tickets.</p> : null}
          </section>

          <section className={PANEL_CLASS}>
            <h2 className={PANEL_HEADING_CLASS}>Answered approvals</h2>
            {approvals.resolved.length === 0 ? (
              <p className={EMPTY_CLASS}>Nothing answered yet.</p>
            ) : (
              approvals.resolved.map((approval) => (
                <Row
                  key={approval.id}
                  inline
                  title={<ApprovalTitle approval={approval} />}
                  meta={
                    <>
                      {approval.resolvedBy ?? 'unknown'} · {clock(approval.resolvedAt)} ·{' '}
                      {approval.consumed ? 'spent by the agent' : 'not spent'}
                    </>
                  }
                >
                  <Chip status={approval.status} />
                </Row>
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

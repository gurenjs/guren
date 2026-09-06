import { Head, router } from '@inertiajs/react'
import { useState, type ReactNode } from 'react'

import type { TriagerState } from '@/app/Agents/Triager'
import type { ApprovalView } from '@/app/Services/approvals'
import type { TicketView } from '@/app/Services/tickets'

/** The five sweep counts, in the order the panel's 5-column grid expects. */
const SWEEP_COUNTS = ['stale', 'asked', 'closed', 'refused', 'deferred'] as const

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

/** The CSS keys off `.row .grow` and `.row .grow.inline`, so `inline` is a class on one layout. */
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
    <div className="row">
      <div className={inline ? 'grow inline' : 'grow'}>
        <span className="title">{title}</span>
        <span className={mono ? 'meta mono' : 'meta'}>{meta}</span>
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
    <div className="shell">
      <Head title="Triager console" />

      <div className="topbar">
        <h1>Triager console</h1>
        <span className="who">signed in as {operator}</span>
        <span className="spacer" />
        <button
          className="primary"
          disabled={busy !== null || agentNote !== null}
          onClick={() => send('sweep', '/console/sweep')}
        >
          {busy === 'sweep' ? 'Sweeping…' : 'Run sweep'}
        </button>
        <button disabled={busy !== null} onClick={() => send('logout', '/logout')}>
          Sign out
        </button>
      </div>

      {errors.approval ? <div className="alert">{errors.approval}</div> : null}
      {errors.sweep ? <div className="alert">{errors.sweep}</div> : null}
      {agentNote ? <div className="alert note">{agentNote}</div> : null}

      <div className="grid">
        <section className="panel">
          <h2>Pending approvals</h2>
          {approvals.pending.length === 0 ? (
            <p className="empty">Nothing waiting on a human.</p>
          ) : (
            approvals.pending.map((approval) => (
              <Row
                key={approval.id}
                title={
                  <>
                    <code className="mono">{approval.tool}</code> — {subject(approval)}
                  </>
                }
                meta={
                  <>
                    asked by {approval.principal} · expires {clock(approval.expiresAt)}
                  </>
                }
              >
                <button
                  className="approve"
                  disabled={busy !== null}
                  onClick={() => send(approval.id, `/console/approvals/${approval.id}/approve`)}
                >
                  Approve
                </button>
                <button
                  className="reject"
                  disabled={busy !== null}
                  onClick={() => send(approval.id, `/console/approvals/${approval.id}/reject`)}
                >
                  Reject
                </button>
              </Row>
            ))
          )}
        </section>

        <section className="panel">
          <h2>Agent report</h2>
          {report === null ? (
            <p className="empty">No agent to ask.</p>
          ) : (
            <>
              <div className="counts">
                {SWEEP_COUNTS.map((key) => (
                  <div key={key}>
                    <div className="n">{sweep?.[key] ?? 0}</div>
                    <div className="k">{key}</div>
                  </div>
                ))}
              </div>
              <Row title="Last sweep" meta={clock(report.lastRunAt)} />
              {sweep?.error ? <div className="alert">{sweep.error}</div> : null}
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
              <div className="row">
                <div className="grow">
                  <span className="title">Settled</span>
                  {report.settled.length === 0 ? (
                    <span className="meta">none yet</span>
                  ) : (
                    report.settled
                      .slice()
                      .reverse()
                      .map((record) => (
                        <span className="meta" key={record.requestId} style={{ display: 'block' }}>
                          <code className="mono">{record.tool}</code> {record.status} · retry{' '}
                          {record.retried ?? 'not run'} · {clock(record.at)}
                        </span>
                      ))
                  )}
                </div>
              </div>
            </>
          )}
        </section>

        <section className="panel">
          <h2>
            Tickets — {open.length} open, {closed.length} closed
          </h2>
          {tickets.map((ticket) => (
            <Row
              key={ticket.id}
              inline
              title={
                <>
                  #{ticket.id} {ticket.title}
                </>
              }
              meta={<>opened {clock(ticket.createdAt)}</>}
            >
              <span className={`tag ${ticket.status}`}>{ticket.status}</span>
            </Row>
          ))}
          {tickets.length === 0 ? <p className="empty">No tickets.</p> : null}
        </section>

        <section className="panel">
          <h2>Answered approvals</h2>
          {approvals.resolved.length === 0 ? (
            <p className="empty">Nothing answered yet.</p>
          ) : (
            approvals.resolved.map((approval) => (
              <Row
                key={approval.id}
                inline
                title={
                  <>
                    <code className="mono">{approval.tool}</code> — {subject(approval)}
                  </>
                }
                meta={
                  <>
                    {approval.resolvedBy ?? 'unknown'} · {clock(approval.resolvedAt)} ·{' '}
                    {approval.consumed ? 'spent by the agent' : 'not spent'}
                  </>
                }
              >
                <span className={`tag ${approval.status}`}>{approval.status}</span>
              </Row>
            ))
          )}
        </section>
      </div>
    </div>
  )
}

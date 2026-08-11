// Copied to the scaffolded app's root by scripts/smoke-golden-path.sh and run
// from there — the relative imports below resolve against that app, not this
// directory, so this file does not resolve when opened or run in place.
import app, { ready } from './src/main.js'
import { Job, registerJob } from '@guren/core'

await ready

// Queue: the scaffolded default is the sync driver — dispatch must execute
// the handler inline, in this process, with no worker.
let probeRan = false
class SmokeProbeJob extends Job<Record<string, never>> {
  async handle(): Promise<void> {
    probeRan = true
  }
}
registerJob(SmokeProbeJob)
const jobId = await SmokeProbeJob.dispatch({})
if (typeof jobId !== 'string' || jobId.length === 0) {
  console.error('Job dispatch did not return a job id')
  process.exit(1)
}
if (!probeRan) {
  console.error('SyncDriver did not execute the dispatched job inline')
  process.exit(1)
}
console.log('Queue OK: sync dispatch executed the job inline')

// The scaffolded sample job must dispatch cleanly too.
const { ProcessWelcomeSequenceJob } = await import('./app/Jobs/ProcessWelcomeSequenceJob.js')
await ProcessWelcomeSequenceJob.dispatch({ source: 'smoke' })

// Mail: the scaffolded default is the log transport — send() must succeed
// and report the log response.
const mailManager = app.container.make('mail') as never
const { WelcomeEmailMail } = await import('./app/Mail/WelcomeEmailMail.js')
const result = (await new WelcomeEmailMail(mailManager).to('smoke@example.com').send()) as {
  success: boolean
  response?: string
  error?: string
}
if (!result.success) {
  console.error('Mail send failed: ' + JSON.stringify(result))
  process.exit(1)
}
if (result.response !== 'Message written to log') {
  console.error('Expected the log transport to handle the message, got: ' + JSON.stringify(result))
  process.exit(1)
}
console.log('Mail OK: ' + result.response)

process.exit(0)

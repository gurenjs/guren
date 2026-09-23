// Runs one passing health check and returns: the process must exit on its own
// well before the check's timeout. Imports source, not dist, so a stale build
// cannot pass.
import { HealthCheck, HealthManager } from '../../src/health'
import type { CheckResult } from '../../src/health'

class PassingCheck extends HealthCheck {
  readonly name = 'passing'
  async check(): Promise<CheckResult> {
    return this.healthy()
  }
}

const manager = new HealthManager().register(new PassingCheck(), { timeout: 60_000 })
const report = await manager.check()
process.stdout.write(`${report.status}\n`)

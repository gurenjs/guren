// Builds one timer-owning object named by argv[2] and returns without stopping
// it: the process must still exit, as a CLI command or script importing an
// app's routes would. Imports source, not dist, so a stale build cannot pass.
import { createRateLimitMiddleware, MemoryRateLimitStore, SlidingWindowRateLimitStore } from '../../../src/http/middleware/rate-limit'
import { MemoryStore } from '../../../src/cache/stores/MemoryStore'
import { Scheduler } from '../../../src/scheduling/Scheduler'

const builders: Record<string, () => unknown> = {
  'rate-limit-middleware': () => createRateLimitMiddleware(),
  'memory-rate-limit-store': () => new MemoryRateLimitStore(),
  'sliding-window-rate-limit-store': () => new SlidingWindowRateLimitStore(),
  'memory-cache-store': () => new MemoryStore(),
  scheduler: () => new Scheduler({ logger: () => {} }).start(),
}

const build = builders[process.argv[2] ?? '']
if (!build) {
  throw new Error(`unknown fixture case: ${process.argv[2]}`)
}

build()
process.stdout.write('built\n')

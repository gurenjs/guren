import { ready } from '../src/main.js'
import { kernel } from '../src/console.js'

try {
  await ready
} catch (error) {
  console.error('Failed to bootstrap application:', error)
  process.exit(1)
}

// process.exit() is required, not just tidy: an idle database pool keeps the
// event loop alive, so returning normally would hang after the command runs.
process.exit(await kernel.handle(process.argv.slice(2)))

/**
 * Subprocess fixture for the signal-teardown case in `application-stop.test.ts`,
 * observable only across a real process boundary: `stop()` detaches the handlers
 * `listen()` registered, and the second `listen()` must put them back, or SIGTERM
 * kills the process by signal instead of the handler exiting 0.
 */
import { Application } from '../../src/http/Application'

const app = new Application()

await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })
await app.stop(true)
const address = await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })

console.log(`READY ${address.port}`)

// Park forever: the parent's signal must be the only way out.
await new Promise(() => {})

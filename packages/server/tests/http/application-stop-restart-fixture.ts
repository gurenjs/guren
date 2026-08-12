/**
 * Subprocess fixture for the signal-teardown case in `application-stop.test.ts`.
 *
 * Runs a full stop/restart cycle and then parks, so the parent can signal it.
 * The behaviour under test is only observable across a real process boundary:
 * `stop()` detaches the SIGINT/SIGTERM handlers `listen()` registered, and the
 * second `listen()` has to put them back. If it doesn't, SIGTERM falls through
 * to its default disposition and kills the process by signal instead of the
 * handler exiting 0.
 */
import { Application } from '../../src/http/Application'

const app = new Application()

await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })
await app.stop(true)
const address = await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })

console.log(`READY ${address.port}`)

// Park forever. The parent's signal is the only way out — an exit of any other
// kind would make the assertion meaningless.
await new Promise(() => {})

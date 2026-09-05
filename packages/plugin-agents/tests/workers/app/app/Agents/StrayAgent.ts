import { GurenAgent } from '../../../../../src/agent'

/**
 * A `GurenAgent` subclass `config/agents.ts` registers nowhere, on purpose.
 *
 * The generator exports exactly the registered classes, so this one reaches the
 * worker the way an app's own hand-written export would — see
 * `tests/workers/build-fixture.ts`.
 */
export class StrayAgent extends GurenAgent<Cloudflare.Env, unknown> {}

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { CLI_BIN_PATH, SERVER_DIST_ENTRY, assertWorkspaceBuilt, createTempWorkspace, linkWorkspaceCore } from './helpers'

/**
 * Spawn the real bin: `bin.ts` exports nothing and builds its commands at
 * module scope, so the citty declaration under test — whether `entity` is a
 * positional or a string — is only observable through a subprocess, and only
 * on stdout: both spellings exit 0, one just prints the whole-project map.
 */
async function runBin(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  assertWorkspaceBuilt([SERVER_DIST_ENTRY])

  const proc = Bun.spawn(['bun', CLI_BIN_PATH, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { exitCode, stdout }
}

/**
 * The smallest workspace `guren context` resolves a model from. Two unrelated
 * models, not one: a repeated `--entity` can only be shown to resolve to its
 * *last* value if the other value would have produced visibly different output.
 */
async function writeModelFixture(dir: string): Promise<void> {
  await mkdir(join(dir, 'app/Models'), { recursive: true })
  await mkdir(join(dir, 'db'), { recursive: true })
  await writeFile(join(dir, 'package.json'), '{}', 'utf8')
  await writeFile(
    join(dir, 'db/schema.ts'),
    `import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: serial('id'),
  email: text('email'),
})

export const posts = pgTable('posts', {
  id: serial('id'),
  title: text('title'),
})
`,
    'utf8',
  )
  await writeFile(
    join(dir, 'app/Models/User.ts'),
    `import { defineModel } from '@guren/orm'
import { users } from '../../db/schema.js'

export class User extends defineModel(users) {}
`,
    'utf8',
  )
  await writeFile(
    join(dir, 'app/Models/Post.ts'),
    `import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends defineModel(posts) {}
`,
    'utf8',
  )
}

/**
 * One route reaching one of the fixture's models, so the bundle's `## Routes`
 * section has something to lose. Deliberately not at `routes/web.ts`, the path
 * `--routes` defaults to: an implementation that dropped the flag entirely
 * would find that file anyway and pass without asserting anything.
 */
const CUSTOM_ROUTES_FILE = 'routes/custom.ts'

async function writeRoutesFixture(dir: string): Promise<void> {
  await linkWorkspaceCore(dir)
  // `guren context` imports the routes file rather than parsing it, so this
  // fixture's `@guren/core` has to resolve.
  await mkdir(join(dir, 'app/Http/Controllers'), { recursive: true })
  await mkdir(join(dir, 'routes'), { recursive: true })
  await writeFile(
    join(dir, 'app/Http/Controllers/UserController.ts'),
    `import { Controller } from '@guren/core'

export class UserController extends Controller {
  async index() {
    return this.json([])
  }
}
`,
    'utf8',
  )
  await writeFile(
    join(dir, CUSTOM_ROUTES_FILE),
    `import type { Router } from '@guren/core'
import { UserController } from '../app/Http/Controllers/UserController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/users', [UserController, 'index'])
}
`,
    'utf8',
  )
}

/**
 * A second `User`, inside a module, so `--module` has something to decide. With
 * one `User` the flag can be dropped entirely and every assertion still holds;
 * with two, dropping it is an ambiguity error and exit 1.
 */
async function writeModuleModelFixture(dir: string): Promise<void> {
  await mkdir(join(dir, 'modules/billing/app/Models'), { recursive: true })
  await mkdir(join(dir, 'modules/billing/db'), { recursive: true })
  await writeFile(
    join(dir, 'modules/billing/db/schema.ts'),
    `import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const users = pgTable('billing_users', {
  id: serial('id'),
  plan: text('plan'),
})
`,
    'utf8',
  )
  await writeFile(
    join(dir, 'modules/billing/app/Models/User.ts'),
    `import { defineModel } from '@guren/orm'
import { users } from '../../db/schema.js'

export class User extends defineModel(users) {}
`,
    'utf8',
  )
}

describe('context entity argument', () => {
  it('resolves the entity from a positional argument', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-positional-')
    try {
      await writeModelFixture(workspace.dir)

      const { exitCode, stdout } = await runBin(['context', 'User'], workspace.dir)

      expect(exitCode).toBe(0)
      expect(stdout).toContain('# User')
      expect(stdout).toContain('## Model — app/Models/User.ts')
      expect(stdout).not.toContain('# Project Context')
    } finally {
      await workspace.cleanup()
    }
  })

  it('resolves the entity from --entity, which citty used to drop silently', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-flag-')
    try {
      await writeModelFixture(workspace.dir)

      const { exitCode, stdout } = await runBin(['context', '--entity', 'User'], workspace.dir)

      expect(exitCode).toBe(0)
      expect(stdout).toContain('# User')
      expect(stdout).toContain('## Model — app/Models/User.ts')
      // An `entity` declared `type: 'positional'` swallows the flag's value
      // entirely and prints the whole-project map instead.
      expect(stdout).not.toContain('# Project Context')
    } finally {
      await workspace.cleanup()
    }
  })

  it('resolves the entity from --entity=<name>', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-flag-eq-')
    try {
      await writeModelFixture(workspace.dir)

      const { exitCode, stdout } = await runBin(['context', '--entity=User'], workspace.dir)

      expect(exitCode).toBe(0)
      expect(stdout).toContain('# User')
      expect(stdout).toContain('## Model — app/Models/User.ts')
      expect(stdout).not.toContain('# Project Context')
    } finally {
      await workspace.cleanup()
    }
  })

  it('still prints the project map when no entity is given', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-none-')
    try {
      await writeModelFixture(workspace.dir)

      const { exitCode, stdout } = await runBin(['context'], workspace.dir)

      expect(exitCode).toBe(0)
      expect(stdout).toContain('# Project Context')
      expect(stdout).not.toContain('## Model — app/Models/User.ts')
      expect(stdout).not.toContain('## Model — app/Models/Post.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('takes the last value of a repeated --entity instead of crashing on the array', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-flag-repeated-')
    try {
      await writeModelFixture(workspace.dir)

      // citty hands a twice-passed `string` arg back as `string[]`. Naming a
      // different entity first pins the half a same-value repeat cannot see:
      // last wins, not first.
      const { exitCode, stdout } = await runBin(
        ['context', '--entity', 'Post', '--entity', 'User'],
        workspace.dir,
      )

      expect(exitCode).toBe(0)
      expect(stdout).toContain('## Model — app/Models/User.ts')
      expect(stdout).not.toContain('app/Models/Post.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('takes the last value of a repeated --module', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-module-repeated-')
    try {
      await writeModelFixture(workspace.dir)
      await writeModuleModelFixture(workspace.dir)

      // The array shape does not crash here, it compares: `['billing', 'app']`
      // matches no model's location. Two `User`s and two different values, so
      // neither dropping the flag (ambiguity, exit 1) nor taking the first
      // (the module's `User`) can reach this assertion.
      const { exitCode, stdout } = await runBin(
        ['context', '--module', 'billing', '--module', 'app', 'User'],
        workspace.dir,
      )

      expect(exitCode).toBe(0)
      expect(stdout).toContain('## Model — app/Models/User.ts')
      expect(stdout).not.toContain('modules/billing/app/Models/User.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('says the routes file could not be read, rather than reporting no routes', async () => {
    // An unloadable routes file rendering what an entity with no routes
    // renders hides a broken environment behind a confident answer.
    const workspace = await createTempWorkspace('guren-cli-context-routes-broken-')
    try {
      await writeModelFixture(workspace.dir)
      await writeRoutesFixture(workspace.dir)
      await writeFile(
        join(workspace.dir, CUSTOM_ROUTES_FILE),
        "import { nothing } from 'package-that-is-not-installed'\nexport function registerWebRoutes(): void { nothing() }\n",
        'utf8',
      )

      const { exitCode, stdout } = await runBin(['context', '--routes', CUSTOM_ROUTES_FILE, 'User'], workspace.dir)

      expect(exitCode).toBe(0)
      expect(stdout).toContain('Routes could not be read:')
      expect(stdout).not.toContain('No routes reference this entity.')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports a --routes path that is not there, rather than reporting no routes', async () => {
    // The other side of the absent-file split: a named file that is not there
    // is a typo or a wrong --app, not the shape an api-only app has.
    const workspace = await createTempWorkspace('guren-cli-entity-routes-typo-')
    try {
      await writeModelFixture(workspace.dir)

      const { exitCode, stdout } = await runBin(
        ['context', '--routes', 'routes/nope.ts', 'User'],
        workspace.dir,
      )

      expect(exitCode).toBe(0)
      expect(stdout).toContain('Routes could not be read:')
      expect(stdout).not.toContain('No routes reference this entity.')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports nothing when the app simply has no routes file', async () => {
    // "Could not be read" has to stay rare enough to mean something: an
    // api-only or mid-scaffold app has no routes file at all, and whole-project
    // `guren context` says so plainly.
    const workspace = await createTempWorkspace('guren-cli-entity-routes-absent-')
    try {
      await writeModelFixture(workspace.dir)

      const { exitCode, stdout } = await runBin(['context', 'User'], workspace.dir)

      expect(exitCode).toBe(0)
      expect(stdout).toContain('No routes reference this entity.')
      expect(stdout).not.toContain('Routes could not be read:')
    } finally {
      await workspace.cleanup()
    }
  })

  it('takes the last value of a repeated --routes, which exited 0 reporting no routes', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-routes-repeated-')
    try {
      await writeModelFixture(workspace.dir)
      await writeRoutesFixture(workspace.dir)

      const single = await runBin(['context', '--routes', CUSTOM_ROUTES_FILE, 'User'], workspace.dir)
      const repeated = await runBin(
        ['context', '--routes', CUSTOM_ROUTES_FILE, '--routes', CUSTOM_ROUTES_FILE, 'User'],
        workspace.dir,
      )

      // Asserted against the single-flag run rather than a literal: this shape
      // does not crash, so the only evidence of a regression is the repeated
      // flag changing the answer.
      expect(single.exitCode).toBe(0)
      expect(single.stdout).toContain('## Routes (1)')
      expect(repeated.exitCode).toBe(0)
      // Both assertions on purpose: equality alone would also hold if the two
      // runs regressed together to `## Routes (0)`.
      expect(repeated.stdout).toContain('## Routes (1)')
      expect(repeated.stdout).toBe(single.stdout)
    } finally {
      await workspace.cleanup()
    }
  })

  it('takes the last value of a repeated --app, which threw inside resolve()', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-app-repeated-')
    try {
      await writeModelFixture(workspace.dir)

      // Run from the parent so `--app` is doing the work rather than agreeing
      // with the cwd, and point the first value somewhere with no models: only
      // last-wins reaches a bundle at all.
      const parent = dirname(workspace.dir)
      const leaf = basename(workspace.dir)
      const { exitCode, stdout } = await runBin(
        ['context', '--app', parent, '--app', leaf, 'User'],
        parent,
      )

      expect(exitCode).toBe(0)
      expect(stdout).toContain('## Model — app/Models/User.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('takes the last value of a repeated --json, which every array made truthy', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-json-repeated-')
    try {
      await writeModelFixture(workspace.dir)

      // A repeated boolean arrays too, and `Boolean([true, false])` is `true`.
      // Only the `=value` spelling can say false, so a bare `--json --json`
      // cannot expose this.
      const { exitCode, stdout } = await runBin(
        ['context', '--json=true', '--json=false', 'User'],
        workspace.dir,
      )

      expect(exitCode).toBe(0)
      expect(stdout).toContain('# User')
      expect(stdout.trimStart().startsWith('{')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps the positional working alongside --module', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-module-')
    try {
      await writeModelFixture(workspace.dir)

      const { exitCode, stdout } = await runBin(['context', '--module', 'app', 'User'], workspace.dir)

      expect(exitCode).toBe(0)
      expect(stdout).toContain('## Model — app/Models/User.ts')
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('queue:retry id argument', () => {
  // `id` stays positional (see bin.ts): the flag spelling is refused loudly
  // rather than silently retrying the wrong job, so it does not need
  // `context`'s treatment.
  it('refuses --id rather than silently retrying nothing', async () => {
    const workspace = await createTempWorkspace('guren-cli-queue-retry-flag-')
    try {
      await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')

      const { exitCode } = await runBin(['queue:retry', '--id', '42'], workspace.dir)

      expect(exitCode).toBe(1)
    } finally {
      await workspace.cleanup()
    }
  })
})

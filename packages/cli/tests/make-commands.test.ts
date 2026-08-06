import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { makeChannel as scaffoldChannel } from '../src/make-channel'
import { makeCommand as scaffoldCommand } from '../src/make-command'
import { makeEvent as scaffoldEvent } from '../src/make-event'
import { makeException as scaffoldException } from '../src/make-exception'
import { makeFactory as scaffoldFactory } from '../src/make-factory'
import { makeJob as scaffoldJob } from '../src/make-job'
import { makeListener as scaffoldListener } from '../src/make-listener'
import { makeMail as scaffoldMail } from '../src/make-mail'
import { makeMiddleware as scaffoldMiddleware } from '../src/make-middleware'
import { makeNotification as scaffoldNotification } from '../src/make-notification'
import { makePolicy as scaffoldPolicy } from '../src/make-policy'
import { makeProvider as scaffoldProvider } from '../src/make-provider'
import { makeResource as scaffoldResource } from '../src/make-resource'
import { makeSeeder as scaffoldSeeder } from '../src/make-seeder'
import { makeValidator as scaffoldValidator } from '../src/make-validator'
import { makeFeature as scaffoldFeature } from '../src/make-feature'
import { parseFieldsString } from '../src/fields'
import type { WriterOptions } from '../src/utils'

// A fixed, predictable path under the shared OS temp dir let another process
// pre-plant a symlink there before a test wrote through it. mkdtempSync's
// random suffix is what makes the directory this test writes into
// unguessable, so it has to be created fresh per test rather than reused.
let TEST_DIR: string

/**
 * Binds a generator to the per-test workspace, so no test has to chdir() the
 * shared process, and fails if the generator ignores the directory it was
 * given.
 *
 * The check is what makes the assertions below mean anything. They match on
 * the returned path (`toContain('app/Jobs/SendEmailJob.ts')`) and on the file
 * existing — both of which still hold when `cwd` is dropped, because the
 * generator really did write that file, just into the checkout instead. Only
 * comparing against the workspace root can tell the two apart.
 */
function inWorkspace<O extends WriterOptions, R>(
  scaffold: (name: string, options?: O) => Promise<R>,
): (name: string, options?: O) => Promise<R> {
  return async (name, options) => {
    const result = await scaffold(name, { ...options, cwd: TEST_DIR } as O)

    for (const written of [result].flat()) {
      if (typeof written === 'string' && !written.startsWith(TEST_DIR + path.sep)) {
        throw new Error(
          `generator ignored cwd and wrote outside the workspace: ${written} (expected under ${TEST_DIR})`,
        )
      }
    }

    return result
  }
}

const makeChannel = inWorkspace(scaffoldChannel)
const makeCommand = inWorkspace(scaffoldCommand)
const makeEvent = inWorkspace(scaffoldEvent)
const makeException = inWorkspace(scaffoldException)
const makeFactory = inWorkspace(scaffoldFactory)
const makeJob = inWorkspace(scaffoldJob)
const makeListener = inWorkspace(scaffoldListener)
const makeMail = inWorkspace(scaffoldMail)
const makeMiddleware = inWorkspace(scaffoldMiddleware)
const makeNotification = inWorkspace(scaffoldNotification)
const makePolicy = inWorkspace(scaffoldPolicy)
const makeProvider = inWorkspace(scaffoldProvider)
const makeResource = inWorkspace(scaffoldResource)
const makeSeeder = inWorkspace(scaffoldSeeder)
const makeValidator = inWorkspace(scaffoldValidator)
const makeFeature = inWorkspace(scaffoldFeature)

describe('CLI make:* commands', () => {
  beforeEach(() => {
    TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guren-cli-test-'))
  })

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true })
    }
  })

  describe('makeJob', () => {
    it('creates a job file', async () => {
      const result = await makeJob('SendEmail')
      expect(result).toContain('app/Jobs/SendEmailJob.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    it('generates correct job template', async () => {
      const result = await makeJob('SendEmail')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain("import { Job } from '@guren/core'")
      expect(content).toContain('class SendEmailJob extends Job')
      expect(content).toContain('interface SendEmailJobPayload')
      expect(content).toContain('async handle(payload: SendEmailJobPayload)')
      expect(content).toContain('async failed(payload: SendEmailJobPayload, error: Error)')
      expect(content).toContain("static override queue = 'default'")
    })

    it('preserves Job suffix if already present', async () => {
      const result = await makeJob('SendEmailJob')
      expect(result).toContain('SendEmailJob.ts')
      expect(result).not.toContain('SendEmailJobJob.ts')
    })

    it('throws if file exists without force', async () => {
      await makeJob('SendEmail')
      await expect(makeJob('SendEmail')).rejects.toThrow('already exists')
    })

    it('overwrites file with force option', async () => {
      await makeJob('SendEmail')
      const result = await makeJob('SendEmail', { force: true })
      expect(fs.existsSync(result)).toBe(true)
    })
  })

  describe('makeEvent', () => {
    it('creates an event file', async () => {
      const result = await makeEvent('UserRegistered')
      expect(result).toContain('app/Events/UserRegistered.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    it('generates correct event template', async () => {
      const result = await makeEvent('UserRegistered')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain("import { Event } from '@guren/core'")
      expect(content).toContain('class UserRegistered extends Event')
      expect(content).toContain("static override eventName = 'UserRegistered'")
    })
  })

  describe('makeListener', () => {
    it('creates a listener file', async () => {
      const result = await makeListener('SendWelcomeEmail')
      expect(result).toContain('app/Listeners/SendWelcomeEmailListener.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    it('generates correct listener template', async () => {
      const result = await makeListener('SendWelcomeEmail')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain("import { Listener, Event } from '@guren/core'")
      expect(content).toContain('class SendWelcomeEmailListener extends Listener')
      expect(content).toContain('async handle(')
      expect(content).toContain('static override shouldQueue = false')
    })

    it('includes event import when specified', async () => {
      const result = await makeListener('SendWelcomeEmail', { event: 'UserRegistered' })
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain("import { UserRegistered } from '../Events/UserRegistered'")
      expect(content).toContain('event: UserRegistered')
      expect(content).toContain('static override event = UserRegistered')
    })

    it('preserves Listener suffix if already present', async () => {
      const result = await makeListener('SendWelcomeEmailListener')
      expect(result).toContain('SendWelcomeEmailListener.ts')
      expect(result).not.toContain('SendWelcomeEmailListenerListener.ts')
    })
  })

  describe('makeMail', () => {
    it('creates a mail file', async () => {
      const result = await makeMail('WelcomeEmail')
      expect(result).toContain('app/Mail/WelcomeEmailMail.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    it('generates correct mail template', async () => {
      const result = await makeMail('WelcomeEmail')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain("import { Mail, type MailManager } from '@guren/core'")
      expect(content).toContain('class WelcomeEmailMail extends Mail')
      expect(content).toContain('manager: MailManager')
      expect(content).not.toContain('getMailManager()')
      expect(content).toContain('build(): this')
      expect(content).toContain('.subject(')
      expect(content).toContain('.text(')
    })
  })

  describe('makeMiddleware', () => {
    it('creates a middleware file', async () => {
      const result = await makeMiddleware('LogRequest')
      expect(result).toContain('app/Http/Middleware/LogRequestMiddleware.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    it('generates correct middleware template', async () => {
      const result = await makeMiddleware('LogRequest')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('defineMiddleware')
      expect(content).toContain('LogRequestMiddleware')
      expect(content).toContain('ctx: Context')
      expect(content).toContain('await next()')
    })
  })

  describe('makePolicy', () => {
    it('creates a policy file', async () => {
      const result = await makePolicy('Post')
      expect(result).toContain('app/Policies/PostPolicy.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    it('generates correct policy template', async () => {
      const result = await makePolicy('Post')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('export class PostPolicy extends Policy')
      expect(content).toContain('viewAny')
      expect(content).toContain('update(user: AuthUser | null, post: PostLike)')
      expect(content).toContain('user.id === post.userId')
    })

    it('does not duplicate the Policy suffix', async () => {
      const result = await makePolicy('CommentPolicy')
      expect(result).toContain('app/Policies/CommentPolicy.ts')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('class CommentPolicy extends Policy')
      expect(content).toContain('comment: CommentLike')
    })
  })

  describe('makeSeeder', () => {
    it('creates a seeder file', async () => {
      const result = await makeSeeder('User')
      expect(result).toContain('db/seeders/UserSeeder.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    it('generates correct seeder template', async () => {
      const result = await makeSeeder('User')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain("import { defineSeeder, type PostgresSeederContext } from '@guren/core'")
      expect(content).toContain('export default defineSeeder(async ({ db }: PostgresSeederContext) => {')
      expect(content).toContain("console.info('Ran UserSeeder.')")
    })

    // The context carries the dialect's drizzle database: annotating every
    // seeder with the PostgreSQL one leaves a MySQL/SQLite app unable to insert
    // into its own schema.
    it('types the context for the schema dialect', async () => {
      fs.mkdirSync(path.join(TEST_DIR, 'db'), { recursive: true })
      fs.writeFileSync(
        path.join(TEST_DIR, 'db/schema.ts'),
        "import { sqliteTable } from 'drizzle-orm/sqlite-core'\n",
      )

      const sqlite = fs.readFileSync(await makeSeeder('User'), 'utf-8')
      expect(sqlite).toContain("import { defineSeeder, type SqliteSeederContext } from '@guren/core'")
      expect(sqlite).toContain('async ({ db }: SqliteSeederContext) => {')

      fs.writeFileSync(
        path.join(TEST_DIR, 'db/schema.ts'),
        "import { mysqlTable } from 'drizzle-orm/mysql-core'\n",
      )

      const mysql = fs.readFileSync(await makeSeeder('Post'), 'utf-8')
      expect(mysql).toContain("import { defineSeeder, type MySqlSeederContext } from '@guren/core'")
      expect(mysql).toContain('async ({ db }: MySqlSeederContext) => {')
    })
  })

  describe('makeValidator', () => {
    it('generates the three schemas a resource controller validates against', async () => {
      const result = await makeValidator('Post')
      expect(result).toContain('app/Http/Validators/PostValidator.ts')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain("import { z } from 'zod'")
      expect(content).toContain('export const PostIdParamSchema = z.object({')
      expect(content).toContain('export const ListPostsQuerySchema = z.object({')
      expect(content).toContain('export const PostPayloadSchema = z.object({')
      expect(content).toContain('export type PostPayload = z.infer<typeof PostPayloadSchema>')
    })

    it('maps each field definition to its zod schema', async () => {
      const result = await makeValidator('Post', {
        fields: parseFieldsString('title:string,views:number,publishedAt:date?'),
      })
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('title: z.string().trim().min(1),')
      expect(content).toContain('views: z.coerce.number(),')
      expect(content).toContain('publishedAt: z.coerce.date().nullable().optional(),')
    })

    // make:feature invents title/body so its model, controller, and pages agree
    // with each other. A standalone validator has no siblings to agree with, so
    // inheriting that default would be two fields the caller has to delete.
    it('leaves the payload empty rather than inheriting make:feature defaults', async () => {
      const content = fs.readFileSync(await makeValidator('Invoice'), 'utf-8')
      const payload = content.split('export const InvoicePayloadSchema = z.object({\n')[1]?.split('\n})')[0]
      expect(payload).toBe('  // Add one entry per column, e.g. title: z.string().trim().min(1),')
    })

    it('pluralizes the list query schema name', async () => {
      const content = fs.readFileSync(await makeValidator('Category'), 'utf-8')
      expect(content).toContain('export const ListCategoriesQuerySchema')
    })

    it('preserves Validator suffix without duplicating it in schema names', async () => {
      const result = await makeValidator('PostValidator')
      expect(result).toContain('app/Http/Validators/PostValidator.ts')
      expect(result).not.toContain('PostValidatorValidator.ts')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('export const PostPayloadSchema')
      expect(content).not.toContain('PostValidatorPayloadSchema')
    })

    it('scaffolds inside a module with the root option', async () => {
      const result = await makeValidator('Invoice', { root: 'Billing' })
      expect(result).toContain('modules/billing/app/Http/Validators/InvoiceValidator.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    // The controller make:feature generates imports these three schema names by
    // hand, so the two commands producing different files is a broken build.
    // Comparing the bytes is what makes that failure reachable — asserting
    // substrings on makeValidator alone would stay green through any drift.
    it('produces byte-identical output to the validator make:feature scaffolds', async () => {
      const fields = 'title:string,views:number,publishedAt:date?'

      await makeFeature('Post', { fields, announce: false })
      const fromFeature = fs.readFileSync(path.join(TEST_DIR, 'app/Http/Validators/PostValidator.ts'), 'utf-8')

      fs.rmSync(path.join(TEST_DIR, 'app/Http/Validators/PostValidator.ts'))
      const fromValidator = fs.readFileSync(await makeValidator('Post', { fields: parseFieldsString(fields) }), 'utf-8')

      expect(fromValidator).toBe(fromFeature)
    })
  })

  describe('makeNotification', () => {
    it('creates a notification file', async () => {
      const result = await makeNotification('InvoicePaid')
      expect(result).toContain('app/Notifications/InvoicePaidNotification.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    it('generates correct notification template', async () => {
      const result = await makeNotification('InvoicePaid')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('class InvoicePaidNotification')
      expect(content).toContain('via()')
      expect(content).toContain('toMail()')
      expect(content).toContain('toDatabase()')
      expect(content).toContain('toArray()')
    })
  })

  describe('makeResource', () => {
    it('creates a resource file', async () => {
      const result = await makeResource('User')
      expect(result).toContain('app/Http/Resources/UserResource.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    it('generates correct resource template', async () => {
      const result = await makeResource('User')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('class UserResource extends Resource')
      expect(content).toContain('toArray()')
      expect(content).toContain('this.resource.id')
    })

    it('uses custom model name', async () => {
      const result = await makeResource('UserProfile', { model: 'Profile' })
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('Resource<ProfileRecord>')
      expect(content).toContain("import type { ProfileRecord } from '../../Models/Profile.js'")
    })

    it('preserves Resource suffix if already present', async () => {
      const result = await makeResource('UserResource')
      expect(result).toContain('UserResource.ts')
      expect(result).not.toContain('UserResourceResource.ts')
    })
  })

  describe('makeFactory', () => {
    it('creates a factory file', async () => {
      const result = await makeFactory('User')
      expect(result).toContain('db/factories/UserFactory.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    it('generates correct factory template', async () => {
      const result = await makeFactory('User')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('class UserFactory extends Factory')
      expect(content).toContain('definition()')
    })

    it('uses custom model name', async () => {
      const result = await makeFactory('Post', { model: 'BlogPost' })
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('typeof BlogPost')
    })

    it('preserves Factory suffix if already present', async () => {
      const result = await makeFactory('UserFactory')
      expect(result).toContain('UserFactory.ts')
      expect(result).not.toContain('UserFactoryFactory.ts')
    })
  })

  describe('makeCommand', () => {
    it('creates a command file', async () => {
      const result = await makeCommand('SendEmails')
      expect(result).toContain('app/Console/Commands/SendEmailsCommand.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    it('generates correct command template', async () => {
      const result = await makeCommand('SendEmails')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('class SendEmailsCommand extends Command')
      expect(content).toContain('static signature')
      expect(content).toContain('static description')
      expect(content).toContain('async handle()')
    })

    it('uses custom command name', async () => {
      const result = await makeCommand('ImportUsers', { command: 'users:import' })
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain("static signature = 'users:import'")
    })

    it('generates kebab-case command name by default', async () => {
      const result = await makeCommand('SendWelcomeEmail')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain("static signature = 'send-welcome-email'")
    })

    it('preserves Command suffix if already present', async () => {
      const result = await makeCommand('SendEmailsCommand')
      expect(result).toContain('SendEmailsCommand.ts')
      expect(result).not.toContain('SendEmailsCommandCommand.ts')
    })
  })

  describe('makeChannel', () => {
    it('creates a channel file', async () => {
      const result = await makeChannel('Chat')
      expect(result).toContain('app/Broadcasting/ChatChannel.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    it('generates correct public channel template', async () => {
      const result = await makeChannel('Chat')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('class ChatChannel extends Channel')
      expect(content).toContain("'chat'")
    })

    it('generates private channel template', async () => {
      const result = await makeChannel('Notifications', { private: true })
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('extends PrivateChannel')
      // The signature has to match ChannelAuthorizer, or the method cannot be
      // registered and silently never runs.
      expect(content).toContain('async authorize(_channelName: string, user: unknown): Promise<boolean>')
      expect(content).toContain('broadcast.privateChannel(')
    })

    it('ties a per-user private channel to the subscriber', async () => {
      const result = await makeChannel('UserFeed', { private: true, channel: 'users.{id}.feed' })
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('async authorize(channelName: string, user: unknown): Promise<boolean>')
      expect(content).toContain('if (!user) return false')
      expect(content).toContain('return channelName === `private-users.${(user as { id: string | number }).id}.feed`')
    })

    it('generates presence channel template', async () => {
      const result = await makeChannel('Room', { presence: true })
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('extends PresenceChannel')
      // Not `join`: the base class already has `join(member)`, and overriding
      // it with an incompatible signature is how the previous template ended up
      // never adding a member.
      expect(content).toContain('async authorizeJoin(_channelName: string, user: unknown): Promise<PresenceMember | null>')
    })

    it('uses custom channel name', async () => {
      const result = await makeChannel('Notifications', { channel: 'user-notifications' })
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain("'user-notifications'")
    })

    it('preserves Channel suffix if already present', async () => {
      const result = await makeChannel('ChatChannel')
      expect(result).toContain('ChatChannel.ts')
      expect(result).not.toContain('ChatChannelChannel.ts')
    })
  })

  describe('makeException', () => {
    it('creates an exception file', async () => {
      const result = await makeException('Payment')
      expect(result).toContain('app/Exceptions/PaymentException.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    it('generates correct exception template', async () => {
      const result = await makeException('Payment')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('class PaymentException extends HttpException')
      expect(content).toContain('constructor(')
      expect(content).toContain('super(')
    })

    it('uses custom status code', async () => {
      const result = await makeException('NotFound', { status: 404 })
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('super(404,')
    })

    it('uses custom default message', async () => {
      const result = await makeException('Payment', { message: 'Payment failed' })
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain("message = 'Payment failed'")
    })

    it('preserves Exception suffix if already present', async () => {
      const result = await makeException('PaymentException')
      expect(result).toContain('PaymentException.ts')
      expect(result).not.toContain('PaymentExceptionException.ts')
    })
  })

  describe('makeProvider', () => {
    it('creates a provider file', async () => {
      const result = await makeProvider('Cache')
      expect(result).toContain('app/Providers/CacheProvider.ts')
      expect(fs.existsSync(result)).toBe(true)
    })

    it('generates correct provider template', async () => {
      const result = await makeProvider('Cache')
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('class CacheProvider extends ServiceProvider')
      expect(content).toContain('register()')
      expect(content).toContain('boot()')
    })

    it('preserves Provider suffix if already present', async () => {
      const result = await makeProvider('CacheProvider')
      expect(result).toContain('CacheProvider.ts')
      expect(result).not.toContain('CacheProviderProvider.ts')
    })
  })
})

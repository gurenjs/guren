import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { makeChannel } from '../src/make-channel'
import { makeCommand } from '../src/make-command'
import { makeEvent } from '../src/make-event'
import { makeException } from '../src/make-exception'
import { makeFactory } from '../src/make-factory'
import { makeJob } from '../src/make-job'
import { makeListener } from '../src/make-listener'
import { makeMail } from '../src/make-mail'
import { makeMiddleware } from '../src/make-middleware'
import { makeNotification } from '../src/make-notification'
import { makePolicy } from '../src/make-policy'
import { makeProvider } from '../src/make-provider'
import { makeResource } from '../src/make-resource'
import { makeSeeder } from '../src/make-seeder'

const TEST_DIR = '/tmp/guren-cli-test'

describe('CLI make:* commands', () => {
  beforeEach(() => {
    // Change working directory to test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true })
    }
    fs.mkdirSync(TEST_DIR, { recursive: true })
    process.chdir(TEST_DIR)
  })

  afterEach(() => {
    // Restore working directory
    process.chdir('/')
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
      expect(content).toContain("import { defineSeeder } from '@guren/core'")
      expect(content).toContain('export default defineSeeder(async () => {')
      expect(content).toContain("console.info('Ran UserSeeder.')")
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
      expect(content).toContain('authorize(ctx: Context)')
    })

    it('generates presence channel template', async () => {
      const result = await makeChannel('Room', { presence: true })
      const content = fs.readFileSync(result, 'utf-8')
      expect(content).toContain('extends PresenceChannel')
      expect(content).toContain('join(ctx: Context)')
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

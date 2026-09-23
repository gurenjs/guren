import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { CommandDef } from 'citty'

import { builtinSubCommands } from '../src/commands'
import { checkPlans } from '../src/plan-check'
import { planApproveFile } from '../src/plan-approve'
import { planNextFile } from '../src/plan-next'
import { renderPlanFile } from '../src/plan-render'
import { planApprovalsPath } from '../src/plan/approvals'
import { judgePlanCommand, PLAN_COMMAND_CLASSES, PLAN_COMMAND_GROUPS, tokenizePlanCommand } from '../src/plan/command-allowlist'
import { planHash } from '../src/plan/identity'
import { PlanDraftSchema, PlanSchema } from '../src/plan/schema'
import { validatePlan } from '../src/plan/validate'
import { createTempRoot, writeWorkspaceFiles } from './helpers'
import { loadApprovedCommentsPlan, loadCommentsPlan, PLAN_APP_FILES, planAppState, planPageData, writePlanVerifyApp } from './plan-fixture'

const MIGRATE = { id: 'command.migrate', command: 'bun run db:migrate', reason: 'The comments table is new.' }
const ATTACHMENTS = { id: 'command.attachments', command: 'guren add attachments', reason: 'Comments take images.' }

function refusal(command: string): string {
  const verdict = judgePlanCommand(command)
  expect(verdict.allowed, command).toBe(false)
  return verdict.allowed ? '' : verdict.reason
}

async function resolveCommand(def: unknown): Promise<CommandDef> {
  return (typeof def === 'function' ? await def() : await def) as CommandDef
}

/** The registry as a plan names it: each builtin command, and each member of a command that has its own subcommands. */
async function registryNames(): Promise<{ names: string[]; groups: string[] }> {
  const names: string[] = []
  const groups: string[] = []
  for (const [name, def] of Object.entries(builtinSubCommands)) {
    const command = await resolveCommand(def)
    const subCommands = command.subCommands === undefined ? undefined : await resolveCommand(command.subCommands)
    if (subCommands === undefined) {
      names.push(name)
      continue
    }
    groups.push(name)
    for (const member of Object.keys(subCommands)) names.push(`${name} ${member}`)
  }
  return { names, groups }
}

describe('tokenizePlanCommand', () => {
  test('should split on spaces and join quoted segments into one word', () => {
    expect(tokenizePlanCommand(`guren  make:feature Post --fields "title:string,body:text?" --attach='cover:one'`)).toEqual({
      words: [
        { text: 'guren', quoted: false },
        { text: 'make:feature', quoted: false },
        { text: 'Post', quoted: false },
        { text: '--fields', quoted: false },
        { text: 'title:string,body:text?', quoted: true },
        { text: '--attach=cover:one', quoted: true },
      ],
    })
  })

  test('should read letters of any script inside quotes, for a plan written in another locale', () => {
    expect(tokenizePlanCommand('guren make:adr "請求サイクルは月末"')).toEqual({
      words: [
        { text: 'guren', quoted: false },
        { text: 'make:adr', quoted: false },
        { text: '請求サイクルは月末', quoted: true },
      ],
    })
  })

  test.each([
    ['guren add session; rm -rf .', '";"'],
    ['guren add session && curl example.com', '"&"'],
    ['guren add session || true', '"|"'],
    ['guren add session | sh', '"|"'],
    ['guren add `whoami`', '"`"'],
    ['guren add $(whoami)', '"$"'],
    ['guren add ${HOME}', '"$"'],
    ['guren add session > out.txt', '">"'],
    ['guren add session < in.txt', '"<"'],
    ['guren add session\nrm -rf .', 'a line break'],
    ['guren add session\r', 'a line break'],
    ['guren add\tsession', 'U+0009'],
    ['guren add session \\', '"\\"'],
    ['guren add sess*', '"*"'],
    ['guren add ~/x', '"~"'],
    ['guren add #x', '"#"'],
    ['guren add (x)', '"("'],
    ['guren make:controller =ls', 'opening with "="'],
    ['guren add session &', '"&"'],
    ['guren make:adr "\u202Eevil"', 'U+202E'],
    ['guren make:adr "a\u200Bb"', 'U+200B'],
  ])('should refuse %j, naming %s', (command, named) => {
    const tokens = tokenizePlanCommand(command)
    expect('unreadable' in tokens).toBe(true)
    expect((tokens as { unreadable: string }).unreadable).toContain(named)
  })

  test.each([
    ['guren make:adr "$(whoami)"', '"$"'],
    ['guren make:adr "`whoami`"', '"`"'],
    ['guren make:adr "a; b"', '";"'],
    ['guren make:adr "a | b"', '"|"'],
    ['guren make:adr "a > b"', '">"'],
    ["guren make:adr 'it\\'s'", '"\\"'],
    ['guren make:adr "line\nbreak"', 'a line break'],
  ])('should refuse a metacharacter inside quotes as well: %j', (command, named) => {
    const tokens = tokenizePlanCommand(command)
    expect((tokens as { unreadable?: string }).unreadable).toContain(named)
  })

  test.each([['guren make:adr "open'], ["guren make:adr 'open"], ['guren make:adr "a" "b']])('should refuse an unbalanced quote: %j', (command) => {
    expect(tokenizePlanCommand(command)).toEqual({ unreadable: expect.stringContaining('quote is never closed') })
  })
})

describe('judgePlanCommand', () => {
  test.each([
    ['guren add attachments', 'add attachments', []],
    ['bunx guren add session', 'add session', []],
    ['guren make:feature Post --fields "title:string,body:text?" --policy', 'make:feature', ['Post', '--fields', 'title:string,body:text?', '--policy']],
    ['bunx guren make:controller Invoice --module billing', 'make:controller', ['Invoice', '--module', 'billing']],
    ['guren add ai --provider anthropic', 'add ai', ['--provider', 'anthropic']],
  ])('should allow %j', (command, subcommand, args) => {
    expect(judgePlanCommand(command)).toEqual({ allowed: true, subcommand, args })
  })

  test.each([
    ['bun run db:migrate', 'not of the form'],
    ['bun x guren add session', 'not of the form'],
    ['npx guren add session', 'not of the form'],
    ['./node_modules/.bin/guren add session', 'not of the form'],
    ['bunx guren@latest add session', 'not of the form'],
    ['bunx --bun guren add session', 'not of the form'],
    ['"guren" add session', 'not of the form'],
    ['rm -rf .', 'not of the form'],
    ['', 'not of the form'],
    ['guren', 'has to follow "guren" directly'],
    ['guren --help', 'has to follow "guren" directly'],
    ['guren "add" session', 'has to follow "guren" directly'],
    ['guren add', '"add" has to be followed directly'],
    ['guren add --force session', '"add" has to be followed directly'],
    ['guren add "session"', '"add" has to be followed directly'],
    ['guren frobnicate', '"frobnicate" is not a subcommand classified for plans'],
    ['guren add frobnicate', '"add frobnicate" is not a subcommand classified for plans'],
    ['guren constructor', '"constructor" is not a subcommand classified for plans'],
    ['guren __proto__', '"__proto__" is not a subcommand classified for plans'],
    ['guren toString', '"toString" is not a subcommand classified for plans'],
    ['guren db:migrate', 'reads or writes a database'],
    ['guren db:fresh', 'reads or writes a database'],
    ['guren deploy --target docker', 'deployment recipes'],
    ['guren add plugin @evil/pkg', 'packages named at run time'],
    ['guren plugin @evil/pkg', 'packages named at run time'],
    ['guren upgrade --install', 'packages named at run time'],
    ['guren plan:approve comments.plan.json', 'acts on plans'],
    ['guren agent:sync', 'agent harness'],
    ['guren dev', "runs the application's code"],
    ['guren gate', "runs the application's code"],
    ['guren key:generate --write', 'app key'],
    ['guren make:migration comments', 'the data step owns migrations'],
    ['guren codegen', 'derived from the code'],
    ['guren check', 'changes nothing'],
  ])('should refuse %j', (command, reason) => {
    expect(refusal(command)).toContain(reason)
  })
})

describe('the classification against the registry', () => {
  test('should classify every registry command, and name none the registry lacks', async () => {
    const { names } = await registryNames()
    const classified = Object.keys(PLAN_COMMAND_CLASSES)

    expect(names.filter((name) => PLAN_COMMAND_CLASSES[name] === undefined), 'registry commands with no classification').toEqual([])
    expect(classified.filter((name) => !names.includes(name)), 'classified names the registry lacks').toEqual([])
  })

  test('should treat exactly the registry commands that carry subcommands as groups', async () => {
    const { groups } = await registryNames()
    expect(groups.sort()).toEqual([...PLAN_COMMAND_GROUPS].sort())
  })

  test('should refuse a registry command the table does not classify', () => {
    expect(PLAN_COMMAND_CLASSES['make:widget']).toBeUndefined()
    expect(refusal('guren make:widget Foo')).toContain('not a subcommand classified for plans')
  })

  test('should allow generators only: make:* writers, lang:publish and add <blueprint>, never add plugin', () => {
    const allowed = Object.entries(PLAN_COMMAND_CLASSES).filter(([, verdict]) => verdict === 'generator').map(([name]) => name)
    for (const name of allowed) expect(name).toMatch(/^(?:make:(?!migration$)[a-z-]+|lang:publish|add (?!plugin$)[a-z]+)$/)
  })
})

describe('the §2 check', () => {
  const planWith = (...commands: Array<Record<string, string>>) => PlanDraftSchema.parse({ ...loadCommentsPlan(), commands })

  test('should fail a refused command beside its element, and pass an allowed one', () => {
    const results = validatePlan(planWith(MIGRATE, ATTACHMENTS), planAppState())
    const commands = results.filter((result) => result.key === 'plan:command')

    expect(commands).toEqual([
      expect.objectContaining({
        status: 'fail',
        title: 'Plan commands',
        elementId: 'command.migrate',
        section: 'commands',
        message: 'The command "bun run db:migrate" is refused: it is not of the form `guren <subcommand> [args…]` or `bunx guren <subcommand> [args…]`.',
      }),
    ])
  })

  test('should quote the command escaped, so a control character cannot reach the terminal', () => {
    const [result] = validatePlan(planWith({ id: 'command.x', command: 'guren add \u001b[2Jsession', reason: 'x' }), planAppState()).filter((entry) => entry.key === 'plan:command')
    expect(result?.message).toStartWith('The command "guren add \\u001b[2Jsession" is refused')
  })
})

describe('the commands that surface it', () => {
  let ROOT: string
  beforeAll(async () => {
    ROOT = await createTempRoot('guren-plan-commands-')
  })
  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true })
  })

  function git(dir: string, ...args: string[]): void {
    const result = Bun.spawnSync(['git', '-c', 'user.name=Approver', '-c', 'user.email=approver@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  }

  async function committedApp(name: string, command: Record<string, string>): Promise<{ app: string; plan: string }> {
    const app = join(ROOT, name)
    await writeWorkspaceFiles(app, { ...PLAN_APP_FILES, 'comments.plan.json': JSON.stringify({ ...loadCommentsPlan(), questions: [], commands: [command] }) })
    git(app, 'init', '-q')
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'init')
    return { app, plan: join(app, 'comments.plan.json') }
  }

  test('plan:approve should refuse a plan carrying a refused command, and approve the same plan with an allowed one', async () => {
    const refused = await committedApp('approve-refused', MIGRATE)
    await expect(planApproveFile(refused.plan, { app: planAppState(), appRoot: refused.app })).rejects.toThrow(/command\.migrate: The command "bun run db:migrate" is refused/)
    expect(await readdir(refused.app)).not.toContain('comments.approvals.json')

    const allowed = await committedApp('approve-allowed', ATTACHMENTS)
    const report = await planApproveFile(allowed.plan, { app: planAppState(), appRoot: allowed.app })
    expect(report.approval.hash).toBeString()
  })

  test('plan:render should put the finding on the page, beside the command', async () => {
    const app = join(ROOT, 'render')
    await writeWorkspaceFiles(app, { 'comments.plan.json': JSON.stringify({ ...loadCommentsPlan(), commands: [MIGRATE] }) })

    const { path } = await renderPlanFile(join(app, 'comments.plan.json'), { app: planAppState(), output: join(app, 'page.html') })

    expect(planPageData(await readFile(path, 'utf8')).checks).toContainEqual(expect.objectContaining({ key: 'plan:command', status: 'fail', elementId: 'command.migrate' }))
  })

  test('plan:next should refuse a draft carrying a refused command before it marks a step', async () => {
    const app = join(ROOT, 'next-draft')
    await writeWorkspaceFiles(app, {
      'package.json': JSON.stringify({ name: 'next-draft', type: 'module' }),
      'comments.plan.json': JSON.stringify({ ...loadCommentsPlan(), commands: [MIGRATE] }),
    })

    await expect(planNextFile(join(app, 'comments.plan.json'), { appRoot: app })).rejects.toThrow(/no step of it is handed out:\n {2}command\.migrate: "bun run db:migrate" is refused/)
    expect(await readdir(app)).not.toContain('.guren')
  })

  test('check --plan should warn on an approved plan whose command the allowlist refuses', async () => {
    const app = join(ROOT, 'check')
    await writePlanVerifyApp(app)
    const document = { ...loadApprovedCommentsPlan(), commands: [MIGRATE, ATTACHMENTS] }
    const path = join(app, 'comments.plan.json')
    await writeFile(path, JSON.stringify(document), 'utf8')
    const hash = planHash(PlanSchema.parse(document))
    await writeFile(planApprovalsPath(path), JSON.stringify({ approvalsVersion: 1, approvals: [{ hash, approvedAt: '2026-09-22T09:00:00.000Z' }] }), 'utf8')

    const results = (await checkPlans({ cwd: app })).filter((result) => result.key.startsWith('plan:command:'))

    expect(results).toEqual([
      expect.objectContaining({ key: 'plan:command:comments.plan.json:command.migrate', status: 'warn', advisory: true, filePath: 'comments.plan.json' }),
    ])
  })
})

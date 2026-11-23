import { resolve } from 'node:path'

import { readAppDefaultLocale } from '../app-locale'
import { BoardOpsDocumentSchema, boardOpsOf } from '../board/ops'
import { boardSlug, deriveBoardSlug } from '../board/schema'
import { applyBoardOpsFile, createBoard, readBoard, type AppliedBoardOpsFile } from '../board/store'
import { renderBoardOutline } from '../board/text'
import { CliError, formatSchemaIssues } from '../cli-error'
import { defineCommand } from '../define-command'
import { readJsonWithinLimit, recoverStdinDash } from '../plan/feedback'

const boardArg = {
  type: 'positional',
  description: 'The board\'s slug: docs/boards/<slug>.board.json.',
  required: true,
  valueHint: 'post-notifications',
} as const

const appArg = {
  type: 'string',
  description: 'Application root directory.',
} as const

function formatApplied(result: AppliedBoardOpsFile, sent: number): string {
  const lines = [`Applied ${result.applied} of ${sent} operations to ${result.file}${result.changed ? '' : ' (the file did not change)'}.`]
  for (const drop of result.dropped) lines.push(`  dropped #${drop.index + 1} (${drop.op}): ${drop.reason}`)
  return lines.join('\n')
}

export const boardNewCommand = defineCommand({
  meta: {
    name: 'board:new',
    description:
      'Create an empty event-storming board at docs/boards/<slug>.board.json (RFC 0041). The slug comes from --slug, else from an ASCII title. Refuses a slug that exists. Loads no application.',
  },
  args: {
    title: {
      type: 'positional',
      description: 'The board\'s title, in any language.',
      required: true,
      valueHint: 'Post notifications',
    },
    slug: {
      type: 'string',
      description: 'Lowercase letters, digits and dashes. Required when the title has no ASCII form.',
      valueHint: 'post-notifications',
    },
    locale: {
      type: 'string',
      description: 'BCP 47 tag of the language the notes are written in. Defaults to the application\'s default locale, else en.',
      valueHint: 'ja',
    },
    app: appArg,
    json: {
      type: 'boolean',
      description: 'Print { slug, file } as JSON.',
      default: false,
    },
  },
  async run({ args }) {
    const appRoot = resolve(args.app ?? process.cwd())
    const slug = args.slug === undefined ? deriveBoardSlug(args.title) : boardSlug(args.slug)
    if (slug === undefined) throw new CliError(`"${args.title}" has no ASCII form to name the file by. Pass one with --slug.`)
    const locale = args.locale ?? (await readAppDefaultLocale(appRoot)) ?? 'en'
    const { file } = await createBoard(appRoot, { slug, title: args.title, locale })
    console.log(args.json ? JSON.stringify({ slug, file }, null, 2) : `${file}\nRead it with: guren board:show ${slug}\nEdit it with: guren board:apply ${slug} --ops <file>`)
  },
})

export const boardShowCommand = defineCommand({
  meta: {
    name: 'board:show',
    description:
      'Print a board as an outline (RFC 0041): each section with its notes in flow order, every arrow on the note it leaves, questions under the note they are about. Coordinates are not shown and carry no meaning. Loads no application.',
  },
  args: {
    board: boardArg,
    app: appArg,
    json: {
      type: 'boolean',
      description: 'Print the board document instead of the outline.',
      default: false,
    },
  },
  async run({ args }) {
    const slug = boardSlug(args.board)
    const board = await readBoard(resolve(args.app ?? process.cwd()), slug)
    process.stdout.write(args.json ? `${JSON.stringify(board, null, 2)}\n` : renderBoardOutline(board, slug))
  },
})

export const boardApplyCommand = defineCommand({
  meta: {
    name: 'board:apply',
    description:
      'Edit a board with a list of operations (RFC 0041): add, edit, move, remove, connect, disconnect, link, section, unsection. A note added without coordinates is placed for you. An operation that cannot apply is dropped and reported, and the rest still apply; the exit code stays 0. Loads no application.',
  },
  args: {
    board: boardArg,
    ops: {
      type: 'string',
      description: 'A JSON file holding the operations, as an array or as { "ops": [...] }; - reads standard input.',
      required: true,
      valueHint: 'ops.json',
    },
    app: appArg,
    json: {
      type: 'boolean',
      description: 'Print { file, changed, applied, dropped } as JSON.',
      default: false,
    },
  },
  async run({ args, rawArgs }) {
    const slug = boardSlug(args.board)
    const source = recoverStdinDash(args.ops, 'ops', rawArgs)
    if (source === undefined || source === '') throw new CliError('--ops needs a file, or - for standard input.')

    const { document, origin } = await readJsonWithinLimit(source, { what: 'operations' })
    const parsed = BoardOpsDocumentSchema.safeParse(document)
    if (!parsed.success) throw new CliError(`The operations on ${origin} do not match their schema:\n${formatSchemaIssues(parsed.error)}`)
    const ops = boardOpsOf(parsed.data)

    const result = await applyBoardOpsFile(resolve(args.app ?? process.cwd()), slug, ops)
    const { file, changed, applied, dropped } = result
    console.log(args.json ? JSON.stringify({ file, changed, applied, dropped }, null, 2) : formatApplied(result, ops.length))
  },
})

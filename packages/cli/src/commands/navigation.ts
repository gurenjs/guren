import { consola } from 'consola'

import { CliError } from '../cli-error'
import { defineCommand } from '../define-command'
import { splitCanFlag, type NavigationFileAuth } from '../navigation-file'
import { addNavigationEntryFile, removeNavigationEntryFile } from '../navigation-writer'

const AUTH_VALUES: readonly NavigationFileAuth[] = ['any', 'required', 'guest']

export function parseCanFlag(value: string): { ability: string; model: string } {
  const can = splitCanFlag(value)
  if (can === undefined) throw new CliError(`--can is "${value}": write it as <ability>:<Model>, such as create:Job.`)
  return can
}

export const navAddCommand = defineCommand({
  meta: {
    name: 'nav:add',
    description:
      'Append an entry to config/navigation.ts (RFC 0040 §5), read back before it is written. --can imports the model from app/Models/<Model>.ts, which must exist.',
  },
  args: {
    label: { type: 'positional', required: true, description: 'The link text, in the default locale.' },
    route: { type: 'string', required: true, description: 'A named GET route with no path parameter.' },
    auth: { type: 'string', description: 'Who sees the entry: required (signed in), guest, or any (the default).' },
    can: { type: 'string', description: 'An ability the gate must allow on a model class, as <ability>:<Model>, such as create:Job.' },
  },
  async run({ args }) {
    const auth = args.auth
    if (auth !== undefined && !AUTH_VALUES.includes(auth as NavigationFileAuth)) {
      throw new CliError(`--auth is "${auth}"; it takes ${AUTH_VALUES.join(', ')}.`)
    }
    const { file, unverified } = await addNavigationEntryFile(process.cwd(), {
      label: args.label,
      route: args.route,
      ...(auth === undefined ? {} : { auth: auth as NavigationFileAuth }),
      ...(args.can === undefined ? {} : { can: parseCanFlag(args.can) }),
    })
    if (unverified) consola.warn(unverified)
    consola.success(`Added the "${args.route}" entry to ${file}.`)
  },
})

export const navRemoveCommand = defineCommand({
  meta: {
    name: 'nav:remove',
    description: 'Remove the entry for a route from config/navigation.ts (RFC 0040 §5), and the import of its can model once nothing else names it.',
  },
  args: {
    route: { type: 'positional', required: true, description: 'The route name the entry links to.' },
  },
  async run({ args }) {
    const file = await removeNavigationEntryFile(process.cwd(), args.route)
    consola.success(`Removed the "${args.route}" entry from ${file}.`)
  },
})

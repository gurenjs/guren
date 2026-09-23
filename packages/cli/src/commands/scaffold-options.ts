import type { WriterOptions } from '../utils'

type ForceableArgs = { force?: boolean; module?: string }

export function toWriterOptions(args: ForceableArgs): WriterOptions {
  return {
    force: Boolean(args.force),
    root: args.module,
  }
}

export const FORCE_ARG = {
  type: 'boolean' as const,
  description: 'Overwrite existing files',
  alias: 'f',
}

export const MODULE_ARG = {
  type: 'string' as const,
  description: 'Scaffold inside modules/<name>/ instead of the project root.',
  alias: 'M',
}

// Keep the field syntax shared with parseFieldsString and every scaffold command.
export const FIELDS_ARG = {
  type: 'string' as const,
  alias: 'F',
  description: 'Comma-separated fields, e.g. "title:string,body:text,published:boolean" (append ? for nullable).',
}

export const ATTACH_ARG = {
  type: 'string' as const,
  description: 'Comma-separated attachment collections, e.g. "cover:one,images:many" (kind defaults to one). Requires the attachments layer — run `guren add attachments` first.',
}

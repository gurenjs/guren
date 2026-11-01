// Imports nothing, so the Dev Center page bundles it to build the command a person pastes.

/** Single-quoted for a POSIX shell, each `'` written `'\''`, so `$`, a backtick or a newline stays text. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

/** Quoted only when a shell would split or expand it. */
export function shellWord(arg: string): string {
  return /^[\w./@:=-]+$/u.test(arg) ? arg : shellQuote(arg)
}

/** A `bunx guren` command line from its arguments. */
export function gurenCommandLine(args: readonly string[]): string {
  return ['bunx', 'guren', ...args.map(shellWord)].join(' ')
}

/**
 * Collects `console.warn` output for the duration of `run`, restoring the real
 * one even when `run` throws. A test that leaks the stub silences every
 * warning after it, in whatever file the runner reaches next.
 */
export async function captureWarnings(run: () => unknown): Promise<string[]> {
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (message: string) => warnings.push(message)

  try {
    await run()
  } finally {
    console.warn = warn
  }

  return warnings
}

import { Output } from '../src/index'

/**
 * An `Output` writing into `lines` instead of the terminal, for asserting what a
 * console command printed. `Output` takes real streams, so the fake is cast.
 */
export function capturingOutput(lines: string[]): Output {
  const stream = {
    write: (chunk: string) => {
      lines.push(String(chunk))
      return true
    },
  } as unknown as NodeJS.WriteStream
  return new Output({ colors: false, stdout: stream, stderr: stream })
}

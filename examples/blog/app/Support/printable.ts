// A newline, carriage return or ESC in a logged value would forge a log line or a
// terminal escape (CWE-117), so each C0 control and DEL is written as `\xNN`.
export function printable(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

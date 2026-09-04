/**
 * Dependency-free monotonic ULID generator (https://github.com/ulid/spec):
 * 48-bit ms timestamp + 80 bits of randomness, Crockford base32.
 *
 * Attachment ids are the sort key for `hasMany` collections, so they must sort
 * even *within* one millisecond — the spec's monotonic mode increments the
 * random half rather than redrawing it. `byte % 32` is bias-free because 256
 * is a multiple of 32.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * The ms timestamp in a ULID's first 10 characters, or `null` for anything that
 * is not a 26-character Crockford string.
 */
export function ulidTime(id: string): number | null {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null
  let time = 0
  for (let i = 0; i < 10; i++) {
    time = time * 32 + ENCODING.indexOf(id[i]!)
  }
  return time
}

let lastTime = -1
// The 16 random characters as base32 digit values (0-31 each).
const lastRandom = new Uint8Array(16)

function freshRandom(): void {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  for (let i = 0; i < 16; i++) lastRandom[i] = bytes[i]! % 32
}

/** Increment the random half; returns false on (astronomically unlikely) overflow. */
function incrementRandom(): boolean {
  for (let i = 15; i >= 0; i--) {
    if (lastRandom[i]! < 31) {
      lastRandom[i]!++
      return true
    }
    lastRandom[i] = 0
  }
  return false
}

export function ulid(now: number = Date.now()): string {
  // A clock that stands still or steps backwards must not break ordering.
  let time = now > lastTime ? now : lastTime
  if (time === lastTime) {
    if (!incrementRandom()) {
      time += 1
      freshRandom()
    }
  } else {
    freshRandom()
  }
  lastTime = time

  let chars = ''
  for (let i = 0; i < 10; i++) {
    chars = ENCODING[time % 32] + chars
    time = Math.floor(time / 32)
  }
  for (let i = 0; i < 16; i++) {
    chars += ENCODING[lastRandom[i]!]
  }
  return chars
}

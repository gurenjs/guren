/**
 * Dependency-free image header sniffer for the attachments pipeline.
 *
 * This backs the two synchronous gates that run on *every* runtime, before
 * any decoder exists: the encoded-byte cap and the header-dimension cap
 * (decompression-bomb defense — the decoder allocates from header-declared
 * dimensions, so the check must happen before decoding). It also detects the
 * HEIC signature so the default 415 rejection needs no decode.
 *
 * Header dimensions are attacker-controlled metadata: they are only ever
 * used to *reject* (too many pixels), never as proof the file is a valid
 * image — validation stays with the full decode where a processor exists.
 */

export interface SniffedImage {
  format: 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'heic'
  /** Header-declared width; absent when the container does not declare one. */
  width?: number
  height?: number
}

export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffGif(bytes) ?? sniffWebp(bytes) ?? sniffIsoBmff(bytes)
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]!)
  return out
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function sniffPng(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 24) return null
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null
  }
  // The first chunk of a valid PNG is IHDR: width and height are the first
  // two fields. A file whose first chunk is not IHDR still sniffs as PNG
  // (magic matched), just without dimensions.
  if (ascii(bytes, 12, 4) !== 'IHDR') return { format: 'png' }
  return { format: 'png', width: u32be(bytes, 16), height: u32be(bytes, 20) }
}

function sniffJpeg(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null

  // Walk the marker segments to the first SOFn frame header, which carries
  // the dimensions. C4 (DHT), C8 (JPG) and CC (DAC) look like SOF markers
  // but are not frame headers.
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = bytes[offset + 1]!
    if (marker === 0xff) {
      offset++
      continue
    }
    // Standalone markers without a length field.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) break // EOI / start of scan: no SOF found
    const length = u16be(bytes, offset + 2)
    if (length < 2) break
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (offset + 9 > bytes.length) break
      return { format: 'jpeg', height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) }
    }
    offset += 2 + length
  }
  return { format: 'jpeg' }
}

function sniffGif(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 10) return null
  const header = ascii(bytes, 0, 6)
  if (header !== 'GIF87a' && header !== 'GIF89a') return null
  return { format: 'gif', width: u16le(bytes, 6), height: u16le(bytes, 8) }
}

function sniffWebp(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 16 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    // Lossy: dimensions follow the 0x9D 0x01 0x2A start code of the key frame.
    if (bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { format: 'webp', width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
    }
    return { format: 'webp' }
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b0 = bytes[21]!
    const b1 = bytes[22]!
    const b2 = bytes[23]!
    const b3 = bytes[24]!
    const width = 1 + (((b1 & 0x3f) << 8) | b0)
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6))
    return { format: 'webp', width, height }
  }
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return { format: 'webp', width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) }
  }
  return { format: 'webp' }
}

const AVIF_BRANDS = new Set(['avif', 'avis'])
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'])

/** AVIF and HEIC/HEIF share the ISO BMFF container; the `ftyp` brands tell them apart. */
function sniffIsoBmff(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') return null
  const boxSize = u32be(bytes, 0)
  if (boxSize < 16 || boxSize > bytes.length) return null

  const brands = [ascii(bytes, 8, 4)]
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    brands.push(ascii(bytes, offset, 4))
  }

  let format: 'avif' | 'heic' | null = null
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) format = 'avif'
  else if (brands.some((brand) => HEIC_BRANDS.has(brand))) format = 'heic'
  if (!format) return null

  const dimensions = findIspe(bytes, 0, bytes.length, 0)
  return dimensions ? { format, ...dimensions } : { format }
}

/** Containers worth descending into on the way to `ipco`'s `ispe` box. */
const BMFF_CONTAINERS = new Set(['meta', 'iprp', 'ipco'])

function findIspe(
  bytes: Uint8Array,
  start: number,
  end: number,
  depth: number,
): { width: number; height: number } | null {
  if (depth > 4) return null
  let offset = start
  while (offset + 8 <= end) {
    const size = u32be(bytes, offset)
    const type = ascii(bytes, offset + 4, 4)
    // size 0 (to end of file) and 1 (64-bit) exist but never wrap the tiny
    // metadata boxes we walk; stop rather than misparse.
    if (size < 8 || offset + size > end) return null
    if (type === 'ispe') {
      // Full box: 1 byte version + 3 bytes flags, then width/height u32.
      if (offset + 20 <= end) {
        return { width: u32be(bytes, offset + 12), height: u32be(bytes, offset + 16) }
      }
      return null
    }
    if (BMFF_CONTAINERS.has(type)) {
      // 'meta' is a full box (4 extra header bytes); 'iprp'/'ipco' are plain.
      const headerSize = type === 'meta' ? 12 : 8
      const found = findIspe(bytes, offset + headerSize, offset + size, depth + 1)
      if (found) return found
    }
    offset += size
  }
  return null
}

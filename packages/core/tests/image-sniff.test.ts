import { describe, expect, test } from 'bun:test'
import { sniffImage } from '../src/attachments/image-sniff'

/** A complete, decodable 1x1 PNG. */
export const PNG_1X1 = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

/** The same PNG with IHDR patched to declare absurd dimensions (CRC now wrong — header gates never check it). */
export function pngWithDeclaredDimensions(width: number, height: number) {
  const bytes = new Uint8Array(PNG_1X1)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

export function jpegHeader(width: number, height: number) {
  // SOI, APP0 (JFIF), SOF0 carrying the dimensions.
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff,
    width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ])
}

export function gifHeader(width: number, height: number) {
  const bytes = new Uint8Array(13)
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) // GIF89a
  bytes[6] = width & 0xff
  bytes[7] = (width >> 8) & 0xff
  bytes[8] = height & 0xff
  bytes[9] = (height >> 8) & 0xff
  return bytes
}

function fourCC(value: string): number[] {
  return [...value].map((c) => c.charCodeAt(0))
}

export function webpLosslessHeader(width: number, height: number) {
  const w = width - 1
  const h = height - 1
  const b0 = w & 0xff
  const b1 = ((w >> 8) & 0x3f) | ((h & 0x03) << 6)
  const b2 = (h >> 2) & 0xff
  const b3 = (h >> 10) & 0x0f
  return new Uint8Array([
    ...fourCC('RIFF'), 0x1a, 0x00, 0x00, 0x00, ...fourCC('WEBP'),
    ...fourCC('VP8L'), 0x0e, 0x00, 0x00, 0x00, 0x2f, b0, b1, b2, b3,
  ])
}

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat()
  const size = 8 + body.length
  return [(size >> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff, ...fourCC(type), ...body]
}

function u32(value: number): number[] {
  return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** ftyp with the given major brand, plus a meta/iprp/ipco/ispe chain declaring dimensions. */
export function isoBmffHeader(brand: string, width?: number, height?: number) {
  const ftyp = box('ftyp', fourCC(brand), u32(0), fourCC('mif1'))
  if (width === undefined || height === undefined) return new Uint8Array(ftyp)
  const ispe = box('ispe', u32(0), u32(width), u32(height))
  const ipco = box('ipco', ispe)
  const iprp = box('iprp', ipco)
  const meta = box('meta', u32(0), iprp)
  return new Uint8Array([...ftyp, ...meta])
}

describe('sniffImage', () => {
  test('should read PNG dimensions from IHDR', () => {
    expect(sniffImage(PNG_1X1)).toEqual({ format: 'png', width: 1, height: 1 })
    expect(sniffImage(pngWithDeclaredDimensions(100_000, 100_000))).toEqual({
      format: 'png',
      width: 100_000,
      height: 100_000,
    })
  })

  test('should read JPEG dimensions from the SOF frame header', () => {
    expect(sniffImage(jpegHeader(640, 480))).toEqual({ format: 'jpeg', width: 640, height: 480 })
  })

  test('should read GIF dimensions', () => {
    expect(sniffImage(gifHeader(320, 200))).toEqual({ format: 'gif', width: 320, height: 200 })
  })

  test('should read WebP lossless dimensions', () => {
    expect(sniffImage(webpLosslessHeader(800, 600))).toEqual({ format: 'webp', width: 800, height: 600 })
  })

  test('should classify AVIF by ftyp brand and read ispe dimensions', () => {
    expect(sniffImage(isoBmffHeader('avif', 1024, 768))).toEqual({ format: 'avif', width: 1024, height: 768 })
  })

  test('should classify HEIC by ftyp brand without needing dimensions', () => {
    expect(sniffImage(isoBmffHeader('heic'))).toEqual({ format: 'heic' })
    expect(sniffImage(isoBmffHeader('heix', 4032, 3024))).toEqual({ format: 'heic', width: 4032, height: 3024 })
  })

  test('should return null for non-image bytes', () => {
    expect(sniffImage(new Uint8Array(Buffer.from('%PDF-1.7 not an image at all')))).toBeNull()
    expect(sniffImage(new Uint8Array(0))).toBeNull()
    expect(sniffImage(new Uint8Array(Buffer.from('GIF10x wrong version')))).toBeNull()
  })

  test('should not classify an unknown ftyp brand as an image', () => {
    expect(sniffImage(isoBmffHeader('mp42'))).toBeNull()
  })
})

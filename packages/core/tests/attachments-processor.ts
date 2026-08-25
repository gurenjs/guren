/**
 * Deterministic stand-in for the runtime processor, shared by the attachment
 * suites so the decode-path tests pass identically on every Bun lane. The
 * real BunImageProcessor is covered by bun-image-processor.test.ts behind the
 * `'Image' in Bun` gate.
 *
 * Pass `overrides` to make one call fail or return other dimensions; keeping
 * one factory here is what stops the suites from drifting into disagreeing
 * about what a decodable image looks like.
 */
import type { ImageProcessor } from '../src/index'

export function fakeProcessor(overrides: Partial<ImageProcessor> = {}): ImageProcessor {
  return {
    async probe(input) {
      if (input.length >= 24 && input[0] === 0x89 && input[1] === 0x50) {
        const view = new DataView(input.buffer, input.byteOffset)
        return {
          width: view.getUint32(16),
          height: view.getUint32(20),
          format: 'png',
          placeholder: 'data:image/png;base64,lqip',
        }
      }
      if (input.length > 11 && String.fromCharCode(...input.slice(4, 8)) === 'ftyp') {
        return { width: 5, height: 5, format: 'heic', placeholder: 'data:image/png;base64,lqip' }
      }
      throw Object.assign(new Error('decode failed'), { code: 'ERR_IMAGE_DECODE_FAILED' })
    },
    async process(_input, spec) {
      return {
        bytes: new Uint8Array([1, 2, 3, 4]),
        width: spec.width ?? 7,
        height: spec.height ?? 7,
        format: spec.format ?? 'jpeg',
      }
    },
    ...overrides,
  }
}

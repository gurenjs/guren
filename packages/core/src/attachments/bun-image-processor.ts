import type { ImageProcessor, VariantSpec } from './types.js'

/**
 * Declared locally so the module typechecks against any `bun-types` version and
 * never leaks Bun types into the public API; feature-detected at runtime.
 */
interface BunImageLike {
  metadata(): Promise<{ width: number; height: number; format: string }>
  placeholder(): Promise<string>
  resize(width: number, height?: number, options?: { fit?: 'fill' | 'inside' }): BunImageLike
  jpeg(options?: { quality?: number }): BunImageLike
  png(options?: Record<string, never>): BunImageLike
  webp(options?: { quality?: number }): BunImageLike
  avif(options?: { quality?: number }): BunImageLike
  bytes(): Promise<Uint8Array>
}

type BunImageConstructor = new (
  input: Uint8Array | ArrayBuffer | Blob,
  options?: { maxPixels?: number },
) => BunImageLike

/**
 * The default {@link ImageProcessor}, backed by `Bun.Image`. Resolved by feature
 * check, never by version: a Bun lane without the API gets no default processor
 * and variants are recorded as `unavailable`.
 *
 * Format support is decided by the OS codecs at call time, so the pipeline
 * branches on `error.code === 'ERR_IMAGE_FORMAT_UNSUPPORTED'` alone — measured
 * counterexamples exist for every hardcoded format×platform table.
 */
class BunImageProcessor implements ImageProcessor {
  constructor(
    private readonly Image: BunImageConstructor,
    private readonly maxPixels: number,
  ) {}

  async probe(
    input: Uint8Array,
    limits: { maxPixels: number },
  ): Promise<{ width: number; height: number; format: string; placeholder?: string }> {
    const image = new this.Image(input, { maxPixels: limits.maxPixels })
    const metadata = await image.metadata()
    // metadata() reads only the header, so truncated files pass it; placeholder()
    // decodes every pixel, validating as it yields the ThumbHash LQIP.
    const placeholder = await image.placeholder()
    return { width: metadata.width, height: metadata.height, format: metadata.format, placeholder }
  }

  async process(
    input: Uint8Array,
    spec: VariantSpec,
  ): Promise<{ bytes: Uint8Array; width: number; height: number; format: string }> {
    const image = new this.Image(input, { maxPixels: this.maxPixels })
    const fit = spec.fit ?? 'inside'

    if (spec.width != null && spec.height != null) {
      image.resize(spec.width, spec.height, { fit })
    } else if (spec.width != null) {
      image.resize(spec.width)
    } else if (spec.height != null) {
      // Bun.Image has no height-only resize; derive the width that keeps the
      // source aspect ratio.
      const metadata = await image.metadata()
      const width = Math.max(1, Math.round((spec.height * metadata.width) / metadata.height))
      image.resize(width, spec.height, { fit })
    }

    const encodeOptions = spec.quality != null ? { quality: spec.quality } : undefined
    switch (spec.format) {
      case 'jpeg':
        image.jpeg(encodeOptions)
        break
      case 'png':
        // PNG is lossless: `quality` has no meaning and `png()` takes no options.
        image.png()
        break
      case 'webp':
        image.webp(encodeOptions)
        break
      case 'avif':
        image.avif(encodeOptions)
        break
      case undefined:
        break
    }

    const bytes = await image.bytes()
    // The instance props describe the *source*, so re-read the output header.
    const output = await new this.Image(bytes).metadata()
    return { bytes, width: output.width, height: output.height, format: output.format }
  }
}

/**
 * `Bun.Image` when present, `null` otherwise (Node/Lambda/Workers — inject a
 * custom processor or let variants degrade to `unavailable`).
 */
export function resolveDefaultImageProcessor(maxPixels: number): ImageProcessor | null {
  if (typeof Bun === 'undefined' || !('Image' in Bun)) return null
  const Image = (Bun as unknown as { Image: BunImageConstructor }).Image
  return new BunImageProcessor(Image, maxPixels)
}

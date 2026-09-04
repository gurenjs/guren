import type { CSSProperties } from 'react'
import type { AttachmentData } from '@guren/core'

type AttachmentImageProps = {
  attachment: AttachmentData
  /** Named variant to render; falls back to the original when unavailable. */
  variant?: string
  alt?: string
  className?: string
  loading?: 'lazy' | 'eager'
  testId?: string
}

// Interpolated into a CSS url(), so only the exact shape the image pipeline
// emits — a base64 image data URL — is accepted; anything else is dropped.
const BASE64_IMAGE_DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i

function lqipStyle(placeholder: string | null): CSSProperties | undefined {
  if (!placeholder || !BASE64_IMAGE_DATA_URL.test(placeholder)) {
    return undefined
  }
  return { backgroundImage: `url("${placeholder}")`, backgroundSize: 'cover' }
}

/** Paints the attachment's ThumbHash LQIP behind the image while the bytes load. */
export default function AttachmentImage({
  attachment,
  variant,
  alt = '',
  className,
  loading,
  testId,
}: AttachmentImageProps) {
  const src = (variant ? attachment.variants[variant]?.url : undefined) ?? attachment.url

  return (
    <img
      src={src}
      alt={alt}
      data-testid={testId}
      loading={loading}
      width={variant ? undefined : attachment.width ?? undefined}
      height={variant ? undefined : attachment.height ?? undefined}
      className={className}
      style={lqipStyle(attachment.placeholder)}
    />
  )
}

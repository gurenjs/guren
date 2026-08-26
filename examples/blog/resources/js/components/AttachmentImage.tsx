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

/**
 * Renders an attachment with its ThumbHash LQIP painted behind the image
 * while the real bytes load.
 */
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
      style={
        attachment.placeholder
          ? { backgroundImage: `url(${attachment.placeholder})`, backgroundSize: 'cover' }
          : undefined
      }
    />
  )
}

/**
 * Validation rule function type.
 */
export type ValidationRule<T = unknown> = (
  value: T,
  field: string,
  data: Record<string, unknown>
) => true | string | Promise<true | string>

/**
 * Validation rule definition.
 */
export interface RuleDefinition {
  name: string
  validate: ValidationRule
  message?: string
}

/**
 * Validation result.
 */
export interface ValidationResult {
  success: boolean
  data?: Record<string, unknown>
  errors?: Record<string, string[]>
}

/**
 * File validation options.
 */
export interface FileValidationOptions {
  /**
   * Maximum file size in bytes.
   */
  maxSize?: number

  /**
   * Allowed MIME types.
   */
  mimes?: string[]

  /**
   * Allowed file extensions.
   */
  extensions?: string[]

  /**
   * Minimum file size in bytes.
   */
  minSize?: number
}

/**
 * Image validation options.
 */
export interface ImageValidationOptions extends FileValidationOptions {
  /**
   * Maximum width in pixels.
   */
  maxWidth?: number

  /**
   * Maximum height in pixels.
   */
  maxHeight?: number

  /**
   * Minimum width in pixels.
   */
  minWidth?: number

  /**
   * Minimum height in pixels.
   */
  minHeight?: number

  /**
   * Required aspect ratio (width/height).
   */
  ratio?: number

  /**
   * Allowed aspect ratio tolerance.
   */
  ratioTolerance?: number
}

/**
 * Validator options.
 */
export interface ValidatorOptions {
  /**
   * Stop on first error for each field.
   * @default true
   */
  stopOnFirstError?: boolean

  /**
   * Custom error messages.
   */
  messages?: Record<string, string>

  /**
   * Custom attribute names for error messages.
   */
  attributes?: Record<string, string>
}

/**
 * File-like interface for validation.
 */
export interface FileLike {
  name: string
  size: number
  type: string
}

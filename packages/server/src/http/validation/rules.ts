import type { ValidationRule, FileValidationOptions, ImageValidationOptions, FileLike } from './types'

/**
 * Built-in validation rules.
 */

/**
 * Required rule - value must be present and not empty.
 */
export function required(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null) {
      return 'The :attribute field is required.'
    }
    if (typeof value === 'string' && value.trim() === '') {
      return 'The :attribute field is required.'
    }
    if (Array.isArray(value) && value.length === 0) {
      return 'The :attribute field is required.'
    }
    return true
  }
}

/**
 * Nullable rule - allows null values (removes other validation if null).
 */
export function nullable(): ValidationRule {
  return () => true
}

/**
 * Required if another field equals a value.
 */
export function requiredIf(field: string, value: unknown): ValidationRule {
  return (v: unknown, _f: string, data: Record<string, unknown>) => {
    if (data[field] === value) {
      if (v === undefined || v === null || v === '') {
        return 'The :attribute field is required.'
      }
    }
    return true
  }
}

/**
 * Required unless another field equals a value.
 */
export function requiredUnless(field: string, value: unknown): ValidationRule {
  return (v: unknown, _f: string, data: Record<string, unknown>) => {
    if (data[field] !== value) {
      if (v === undefined || v === null || v === '') {
        return 'The :attribute field is required.'
      }
    }
    return true
  }
}

/**
 * Required with - field is required if any of the other fields are present.
 */
export function requiredWith(...fields: string[]): ValidationRule {
  return (v: unknown, _f: string, data: Record<string, unknown>) => {
    const hasAny = fields.some((f) => data[f] !== undefined && data[f] !== null && data[f] !== '')
    if (hasAny && (v === undefined || v === null || v === '')) {
      return 'The :attribute field is required.'
    }
    return true
  }
}

/**
 * Required without - field is required if any of the other fields are not present.
 */
export function requiredWithout(...fields: string[]): ValidationRule {
  return (v: unknown, _f: string, data: Record<string, unknown>) => {
    const missingAny = fields.some((f) => data[f] === undefined || data[f] === null || data[f] === '')
    if (missingAny && (v === undefined || v === null || v === '')) {
      return 'The :attribute field is required.'
    }
    return true
  }
}

/**
 * String rule - value must be a string.
 */
export function string(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null) return true
    if (typeof value !== 'string') {
      return 'The :attribute must be a string.'
    }
    return true
  }
}

/**
 * Numeric rule - value must be a number.
 */
export function numeric(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null) return true
    if (typeof value === 'number' && !isNaN(value)) return true
    if (typeof value === 'string' && !isNaN(Number(value))) return true
    return 'The :attribute must be a number.'
  }
}

/**
 * Integer rule - value must be an integer.
 */
export function integer(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null) return true
    const num = typeof value === 'string' ? Number(value) : value
    if (typeof num !== 'number' || isNaN(num) || !Number.isInteger(num)) {
      return 'The :attribute must be an integer.'
    }
    return true
  }
}

/**
 * Boolean rule - value must be a boolean.
 */
export function boolean(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null) return true
    if (
      typeof value === 'boolean' ||
      value === 'true' ||
      value === 'false' ||
      value === '1' ||
      value === '0' ||
      value === 1 ||
      value === 0
    ) {
      return true
    }
    return 'The :attribute must be a boolean.'
  }
}

/**
 * Array rule - value must be an array.
 */
export function array(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null) return true
    if (!Array.isArray(value)) {
      return 'The :attribute must be an array.'
    }
    return true
  }
}

/**
 * Object rule - value must be an object.
 */
export function object(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null) return true
    if (typeof value !== 'object' || Array.isArray(value)) {
      return 'The :attribute must be an object.'
    }
    return true
  }
}

/**
 * Email rule - value must be a valid email.
 */
export function email(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string') {
      return 'The :attribute must be a valid email address.'
    }
    if (!isPlausibleEmail(value)) {
      return 'The :attribute must be a valid email address.'
    }
    return true
  }
}

/**
 * Same accept set as `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` — non-empty local part,
 * exactly one `@`, no whitespace, and a dot inside the domain with at least
 * one character on each side — but scanned linearly. That regex backtracks
 * quadratically on request-derived input (e.g. `"a@" + ".".repeat(n) + " "`).
 */
function isPlausibleEmail(value: string): boolean {
  const at = value.indexOf('@')
  if (at <= 0 || value.indexOf('@', at + 1) !== -1) {
    return false
  }
  if (/\s/u.test(value)) {
    return false
  }
  const domain = value.slice(at + 1)
  return domain.slice(1, -1).includes('.')
}

/**
 * URL rule - value must be a valid URL.
 */
export function url(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string') {
      return 'The :attribute must be a valid URL.'
    }
    try {
      new URL(value)
      return true
    } catch {
      return 'The :attribute must be a valid URL.'
    }
  }
}

/**
 * UUID rule - value must be a valid UUID.
 */
export function uuid(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string') {
      return 'The :attribute must be a valid UUID.'
    }
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(value)) {
      return 'The :attribute must be a valid UUID.'
    }
    return true
  }
}

/**
 * Minimum rule - value must be at least min.
 */
export function min(minValue: number): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true

    if (typeof value === 'string') {
      if (value.length < minValue) {
        return `The :attribute must be at least ${minValue} characters.`
      }
    } else if (typeof value === 'number') {
      if (value < minValue) {
        return `The :attribute must be at least ${minValue}.`
      }
    } else if (Array.isArray(value)) {
      if (value.length < minValue) {
        return `The :attribute must have at least ${minValue} items.`
      }
    }
    return true
  }
}

/**
 * Maximum rule - value must be at most max.
 */
export function max(maxValue: number): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true

    if (typeof value === 'string') {
      if (value.length > maxValue) {
        return `The :attribute must not exceed ${maxValue} characters.`
      }
    } else if (typeof value === 'number') {
      if (value > maxValue) {
        return `The :attribute must not exceed ${maxValue}.`
      }
    } else if (Array.isArray(value)) {
      if (value.length > maxValue) {
        return `The :attribute must not have more than ${maxValue} items.`
      }
    }
    return true
  }
}

/**
 * Between rule - value must be between min and max.
 */
export function between(minValue: number, maxValue: number): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true

    if (typeof value === 'string') {
      if (value.length < minValue || value.length > maxValue) {
        return `The :attribute must be between ${minValue} and ${maxValue} characters.`
      }
    } else if (typeof value === 'number') {
      if (value < minValue || value > maxValue) {
        return `The :attribute must be between ${minValue} and ${maxValue}.`
      }
    } else if (Array.isArray(value)) {
      if (value.length < minValue || value.length > maxValue) {
        return `The :attribute must have between ${minValue} and ${maxValue} items.`
      }
    }
    return true
  }
}

/**
 * Size rule - value must be exactly size.
 */
export function size(exactSize: number): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true

    if (typeof value === 'string' && value.length !== exactSize) {
      return `The :attribute must be exactly ${exactSize} characters.`
    }
    if (typeof value === 'number' && value !== exactSize) {
      return `The :attribute must be ${exactSize}.`
    }
    if (Array.isArray(value) && value.length !== exactSize) {
      return `The :attribute must contain exactly ${exactSize} items.`
    }
    return true
  }
}

/**
 * In rule - value must be in the given array.
 */
export function inValues(values: unknown[]): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (!values.includes(value)) {
      return `The selected :attribute is invalid.`
    }
    return true
  }
}

/**
 * Not in rule - value must not be in the given array.
 */
export function notIn(values: unknown[]): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (values.includes(value)) {
      return `The selected :attribute is invalid.`
    }
    return true
  }
}

/**
 * Regex rule - value must match the regex.
 */
export function regex(pattern: RegExp): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string') {
      return 'The :attribute format is invalid.'
    }
    if (!pattern.test(value)) {
      return 'The :attribute format is invalid.'
    }
    return true
  }
}

/**
 * Confirmed rule - field must have a matching field_confirmation.
 */
export function confirmed(): ValidationRule {
  return (value: unknown, field: string, data: Record<string, unknown>) => {
    const confirmField = `${field}_confirmation`
    if (value !== data[confirmField]) {
      return 'The :attribute confirmation does not match.'
    }
    return true
  }
}

/**
 * Same rule - field must match another field.
 */
export function same(otherField: string): ValidationRule {
  return (value: unknown, _field: string, data: Record<string, unknown>) => {
    if (value !== data[otherField]) {
      return `The :attribute and ${otherField} must match.`
    }
    return true
  }
}

/**
 * Different rule - field must be different from another field.
 */
export function different(otherField: string): ValidationRule {
  return (value: unknown, _field: string, data: Record<string, unknown>) => {
    if (value === data[otherField]) {
      return `The :attribute and ${otherField} must be different.`
    }
    return true
  }
}

/**
 * After rule - date must be after another date.
 */
export function after(date: string | Date): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    const inputDate = new Date(value as string)
    const compareDate = typeof date === 'string' ? new Date(date) : date
    if (isNaN(inputDate.getTime())) {
      return 'The :attribute is not a valid date.'
    }
    if (inputDate <= compareDate) {
      return `The :attribute must be after ${compareDate.toISOString()}.`
    }
    return true
  }
}

/**
 * After or equal rule - date must be after or equal to another date.
 */
export function afterOrEqual(date: string | Date): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    const inputDate = new Date(value as string)
    const compareDate = typeof date === 'string' ? new Date(date) : date
    if (isNaN(inputDate.getTime())) {
      return 'The :attribute is not a valid date.'
    }
    if (inputDate < compareDate) {
      return `The :attribute must be after or equal to ${compareDate.toISOString()}.`
    }
    return true
  }
}

/**
 * Before rule - date must be before another date.
 */
export function before(date: string | Date): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    const inputDate = new Date(value as string)
    const compareDate = typeof date === 'string' ? new Date(date) : date
    if (isNaN(inputDate.getTime())) {
      return 'The :attribute is not a valid date.'
    }
    if (inputDate >= compareDate) {
      return `The :attribute must be before ${compareDate.toISOString()}.`
    }
    return true
  }
}

/**
 * Before or equal rule - date must be before or equal to another date.
 */
export function beforeOrEqual(date: string | Date): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    const inputDate = new Date(value as string)
    const compareDate = typeof date === 'string' ? new Date(date) : date
    if (isNaN(inputDate.getTime())) {
      return 'The :attribute is not a valid date.'
    }
    if (inputDate > compareDate) {
      return `The :attribute must be before or equal to ${compareDate.toISOString()}.`
    }
    return true
  }
}

/**
 * Date rule - value must be a valid date.
 */
export function date(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    const dateValue = new Date(value as string)
    if (isNaN(dateValue.getTime())) {
      return 'The :attribute is not a valid date.'
    }
    return true
  }
}

/**
 * Date format rule - value must match the given format.
 */
export function dateFormat(format: string): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string') {
      return `The :attribute does not match the format ${format}.`
    }
    // Basic format validation
    const patterns: Record<string, RegExp> = {
      'YYYY-MM-DD': /^\d{4}-\d{2}-\d{2}$/,
      'DD/MM/YYYY': /^\d{2}\/\d{2}\/\d{4}$/,
      'MM/DD/YYYY': /^\d{2}\/\d{2}\/\d{4}$/,
      'YYYY-MM-DD HH:mm:ss': /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    }
    const pattern = patterns[format]
    if (!pattern || !pattern.test(value)) {
      return `The :attribute does not match the format ${format}.`
    }
    return true
  }
}

/**
 * Alpha rule - value must only contain letters.
 */
export function alpha(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string' || !/^[a-zA-Z]+$/.test(value)) {
      return 'The :attribute may only contain letters.'
    }
    return true
  }
}

/**
 * Alpha numeric rule - value must only contain letters and numbers.
 */
export function alphaNum(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string' || !/^[a-zA-Z0-9]+$/.test(value)) {
      return 'The :attribute may only contain letters and numbers.'
    }
    return true
  }
}

/**
 * Alpha dash rule - value must only contain letters, numbers, dashes, and underscores.
 */
export function alphaDash(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) {
      return 'The :attribute may only contain letters, numbers, dashes, and underscores.'
    }
    return true
  }
}

/**
 * Starts with rule - value must start with one of the given prefixes.
 */
export function startsWith(...prefixes: string[]): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string') {
      return `The :attribute must start with one of the following: ${prefixes.join(', ')}.`
    }
    if (!prefixes.some((prefix) => value.startsWith(prefix))) {
      return `The :attribute must start with one of the following: ${prefixes.join(', ')}.`
    }
    return true
  }
}

/**
 * Ends with rule - value must end with one of the given suffixes.
 */
export function endsWith(...suffixes: string[]): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string') {
      return `The :attribute must end with one of the following: ${suffixes.join(', ')}.`
    }
    if (!suffixes.some((suffix) => value.endsWith(suffix))) {
      return `The :attribute must end with one of the following: ${suffixes.join(', ')}.`
    }
    return true
  }
}

/**
 * JSON rule - value must be a valid JSON string.
 */
export function json(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string') {
      return 'The :attribute must be a valid JSON string.'
    }
    try {
      JSON.parse(value)
      return true
    } catch {
      return 'The :attribute must be a valid JSON string.'
    }
  }
}

/**
 * IP rule - value must be a valid IP address.
 */
export function ip(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string') {
      return 'The :attribute must be a valid IP address.'
    }
    // IPv4 pattern
    const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/
    // Simple IPv6 pattern
    const ipv6 = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/
    if (!ipv4.test(value) && !ipv6.test(value)) {
      return 'The :attribute must be a valid IP address.'
    }
    return true
  }
}

/**
 * IPv4 rule - value must be a valid IPv4 address.
 */
export function ipv4(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string') {
      return 'The :attribute must be a valid IPv4 address.'
    }
    const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/
    if (!ipv4.test(value)) {
      return 'The :attribute must be a valid IPv4 address.'
    }
    return true
  }
}

/**
 * IPv6 rule - value must be a valid IPv6 address.
 */
export function ipv6(): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string') {
      return 'The :attribute must be a valid IPv6 address.'
    }
    // Simplified IPv6 validation
    const ipv6 = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/
    if (!ipv6.test(value)) {
      return 'The :attribute must be a valid IPv6 address.'
    }
    return true
  }
}

// File validation rules

/**
 * File rule - validates a file object.
 */
export function file(options: FileValidationOptions = {}): ValidationRule {
  return (value: unknown) => {
    if (value === undefined || value === null) return true

    const fileValue = value as FileLike
    if (!fileValue || typeof fileValue !== 'object') {
      return 'The :attribute must be a file.'
    }

    if (!('name' in fileValue) || !('size' in fileValue) || !('type' in fileValue)) {
      return 'The :attribute must be a file.'
    }

    if (options.maxSize && fileValue.size > options.maxSize) {
      return `The :attribute must not exceed ${formatBytes(options.maxSize)}.`
    }

    if (options.minSize && fileValue.size < options.minSize) {
      return `The :attribute must be at least ${formatBytes(options.minSize)}.`
    }

    if (options.mimes && options.mimes.length > 0) {
      if (!options.mimes.includes(fileValue.type)) {
        return `The :attribute must be a file of type: ${options.mimes.join(', ')}.`
      }
    }

    if (options.extensions && options.extensions.length > 0) {
      const ext = fileValue.name.split('.').pop()?.toLowerCase()
      if (!ext || !options.extensions.includes(ext)) {
        return `The :attribute must have an extension of: ${options.extensions.join(', ')}.`
      }
    }

    return true
  }
}

/**
 * Image rule - validates an image file.
 */
export function image(options: ImageValidationOptions = {}): ValidationRule {
  const defaultMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']

  return (value: unknown) => {
    if (value === undefined || value === null) return true

    const fileValue = value as FileLike
    if (!fileValue || typeof fileValue !== 'object') {
      return 'The :attribute must be an image.'
    }

    if (!('name' in fileValue) || !('size' in fileValue) || !('type' in fileValue)) {
      return 'The :attribute must be an image.'
    }

    // Check MIME type
    const allowedMimes = options.mimes ?? defaultMimes
    if (!allowedMimes.includes(fileValue.type)) {
      return 'The :attribute must be an image.'
    }

    // Apply file validation
    if (options.maxSize && fileValue.size > options.maxSize) {
      return `The :attribute must not exceed ${formatBytes(options.maxSize)}.`
    }

    if (options.minSize && fileValue.size < options.minSize) {
      return `The :attribute must be at least ${formatBytes(options.minSize)}.`
    }

    return true
  }
}

/**
 * Mimes rule - validates file MIME types.
 */
export function mimes(...mimeTypes: string[]): ValidationRule {
  return file({ mimes: mimeTypes })
}

/**
 * Max file size rule.
 */
export function maxFileSize(bytes: number): ValidationRule {
  return file({ maxSize: bytes })
}

/**
 * Min file size rule.
 */
export function minFileSize(bytes: number): ValidationRule {
  return file({ minSize: bytes })
}

/**
 * Helper to format bytes.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/**
 * Custom rule - create a custom validation rule.
 */
export function custom(
  validate: (value: unknown, field: string, data: Record<string, unknown>) => boolean | string | Promise<boolean | string>,
  message?: string
): ValidationRule {
  return async (value: unknown, field: string, data: Record<string, unknown>) => {
    const result = await validate(value, field, data)
    if (result === true) return true
    if (result === false) return message ?? 'The :attribute is invalid.'
    return result
  }
}

/**
 * Unique rule (async) - checks uniqueness via callback.
 */
export function unique(
  callback: (value: unknown, field: string) => Promise<boolean>
): ValidationRule {
  return async (value: unknown, field: string) => {
    if (value === undefined || value === null || value === '') return true
    const isUnique = await callback(value, field)
    if (!isUnique) {
      return 'The :attribute has already been taken.'
    }
    return true
  }
}

/**
 * Exists rule (async) - checks existence via callback.
 */
export function exists(
  callback: (value: unknown, field: string) => Promise<boolean>
): ValidationRule {
  return async (value: unknown, field: string) => {
    if (value === undefined || value === null || value === '') return true
    const doesExist = await callback(value, field)
    if (!doesExist) {
      return 'The selected :attribute is invalid.'
    }
    return true
  }
}

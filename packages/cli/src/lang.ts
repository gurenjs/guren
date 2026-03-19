import { consola } from 'consola'
import { resolve, join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, copyFileSync } from 'node:fs'

export interface LangPublishOptions {
  /**
   * Application root directory.
   */
  appRoot?: string

  /**
   * Path to the language files directory.
   */
  path?: string

  /**
   * Overwrite existing files.
   */
  force?: boolean
}

export interface MakeLangOptions {
  /**
   * Application root directory.
   */
  appRoot?: string

  /**
   * Path to the language files directory.
   */
  path?: string

  /**
   * Copy structure from existing locale.
   */
  from?: string

  /**
   * Overwrite existing files.
   */
  force?: boolean
}

// Default language templates
const defaultMessages = {
  welcome: 'Welcome to our application!',
  greeting: 'Hello, :name!',
  goodbye: 'Goodbye!',
  items: {
    count: 'You have :count item|You have :count items',
  },
}

const defaultValidation = {
  required: 'The :attribute field is required.',
  email: 'The :attribute must be a valid email address.',
  string: 'The :attribute must be a string.',
  numeric: 'The :attribute must be a number.',
  min: {
    string: 'The :attribute must be at least :min characters.',
    numeric: 'The :attribute must be at least :min.',
  },
  max: {
    string: 'The :attribute may not be greater than :max characters.',
    numeric: 'The :attribute may not be greater than :max.',
  },
  between: {
    string: 'The :attribute must be between :min and :max characters.',
    numeric: 'The :attribute must be between :min and :max.',
  },
  confirmed: 'The :attribute confirmation does not match.',
  unique: 'The :attribute has already been taken.',
  exists: 'The selected :attribute is invalid.',
}

const defaultAuth = {
  failed: 'These credentials do not match our records.',
  password: 'The provided password is incorrect.',
  throttle: 'Too many login attempts. Please try again in :seconds seconds.',
  login: {
    success: 'You have been logged in successfully.',
    required: 'Please login to continue.',
  },
  logout: {
    success: 'You have been logged out successfully.',
  },
  register: {
    success: 'Your account has been created successfully.',
  },
  verify: {
    sent: 'A verification link has been sent to your email address.',
    success: 'Your email has been verified successfully.',
    invalid: 'The verification link is invalid or has expired.',
  },
  password_reset: {
    sent: 'We have emailed your password reset link.',
    success: 'Your password has been reset successfully.',
    invalid: 'The password reset token is invalid or has expired.',
  },
}

const defaultPagination = {
  previous: 'Previous',
  next: 'Next',
  showing: 'Showing :from to :to of :total results',
}

/**
 * Publish default language files.
 */
export function publishLanguageFiles(options: LangPublishOptions = {}): string[] {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const langPath = options.path ? resolve(appRoot, options.path) : resolve(appRoot, 'lang')

  const createdFiles: string[] = []

  // Create lang directory
  if (!existsSync(langPath)) {
    mkdirSync(langPath, { recursive: true })
    consola.info(`Created directory: ${langPath}`)
  }

  // Create English locale
  const enPath = join(langPath, 'en')
  if (!existsSync(enPath)) {
    mkdirSync(enPath, { recursive: true })
  }

  const files: Record<string, Record<string, unknown>> = {
    'messages.json': defaultMessages,
    'validation.json': defaultValidation,
    'auth.json': defaultAuth,
    'pagination.json': defaultPagination,
  }

  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(enPath, filename)

    if (existsSync(filePath) && !options.force) {
      consola.warn(`File already exists: ${filePath} (use --force to overwrite)`)
      continue
    }

    writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n')
    createdFiles.push(filePath)
    consola.success(`Created: ${filePath}`)
  }

  return createdFiles
}

/**
 * Create a new language locale.
 */
export function makeLanguage(locale: string, options: MakeLangOptions = {}): string[] {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const langPath = options.path ? resolve(appRoot, options.path) : resolve(appRoot, 'lang')

  // Validate locale format
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(locale)) {
    consola.error(`Invalid locale format: ${locale}`)
    consola.info('Expected format: xx or xx-XX (e.g., en, ja, en-US, pt-BR)')
    return []
  }

  const localePath = join(langPath, locale)
  const createdFiles: string[] = []

  // Check if locale already exists
  if (existsSync(localePath) && !options.force) {
    consola.error(`Locale already exists: ${localePath}`)
    consola.info('Use --force to overwrite existing files.')
    return []
  }

  // Create locale directory
  if (!existsSync(localePath)) {
    mkdirSync(localePath, { recursive: true })
  }

  // Copy from existing locale or create empty files
  if (options.from) {
    const fromPath = join(langPath, options.from)

    if (!existsSync(fromPath)) {
      consola.error(`Source locale not found: ${fromPath}`)
      return []
    }

    // Copy files from source locale
    const files = readdirSync(fromPath).filter((f) => f.endsWith('.json'))

    for (const file of files) {
      const sourcePath = join(fromPath, file)
      const targetPath = join(localePath, file)

      if (existsSync(targetPath) && !options.force) {
        consola.warn(`File already exists: ${targetPath} (use --force to overwrite)`)
        continue
      }

      copyFileSync(sourcePath, targetPath)
      createdFiles.push(targetPath)
      consola.success(`Created: ${targetPath}`)
    }
  } else {
    // Create empty template files
    const emptyFiles: Record<string, Record<string, string>> = {
      'messages.json': {
        welcome: '',
        greeting: '',
        goodbye: '',
      },
      'validation.json': {
        required: '',
        email: '',
        string: '',
        numeric: '',
      },
      'auth.json': {
        failed: '',
        password: '',
        throttle: '',
      },
      'pagination.json': {
        previous: '',
        next: '',
        showing: '',
      },
    }

    for (const [filename, content] of Object.entries(emptyFiles)) {
      const filePath = join(localePath, filename)

      if (existsSync(filePath) && !options.force) {
        consola.warn(`File already exists: ${filePath} (use --force to overwrite)`)
        continue
      }

      writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n')
      createdFiles.push(filePath)
      consola.success(`Created: ${filePath}`)
    }
  }

  if (createdFiles.length > 0) {
    consola.info('')
    consola.info(`Locale "${locale}" created with ${createdFiles.length} file(s).`)
    consola.info('Edit the JSON files to add your translations.')
  }

  return createdFiles
}

/**
 * List available locales.
 */
export function listLocales(options: LangPublishOptions = {}): string[] {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const langPath = options.path ? resolve(appRoot, options.path) : resolve(appRoot, 'lang')

  if (!existsSync(langPath)) {
    return []
  }

  const entries = readdirSync(langPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

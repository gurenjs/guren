let patched = false

/**
 * Bun 1.x throws from Error.captureStackTrace unless the first argument is a
 * real Error. Packages that pass plain objects (notably follow-redirects, which
 * Node tolerates) then crash SSR boot before Inertia can import the SSR entry.
 * This mirrors Node by copying a real Error's stack onto whatever it is given.
 */
export function ensureErrorStackTracePolyfill(): void {
  if (patched) {
    return
  }

  const capture = (Error as typeof Error & { captureStackTrace?: typeof Error.captureStackTrace }).captureStackTrace

  if (typeof capture !== 'function') {
    ; (Error as any).captureStackTrace = (target: any) => copyStackFromNewError(target)
    patched = true
    return
  }

  ; (Error as any).captureStackTrace = (target: any, constructorOpt?: (...args: any[]) => any) => {
    // Let Bun handle genuine Errors so we retain native stack formatting when possible.
    if (target instanceof Error) {
      try {
        return capture(target, constructorOpt)
      } catch {
        // Bun 1.3.1 still throws in some edge cases, so we fall back to cloning below.
      }
    }

    const placeholder = new Error()
    capture(placeholder, constructorOpt)
    copyStackFromError(target, placeholder)
    return target
  }

  patched = true
}

function copyStackFromNewError(target: any): void {
  const placeholder = new Error()
  copyStackFromError(target, placeholder)
}

function copyStackFromError(target: any, source: Error): void {
  if (!target || typeof target !== 'object') {
    return
  }

  // Directly defining non-enumerable properties to match native Error behavior.
  if (source.stack) {
    Object.defineProperty(target, 'stack', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: source.stack,
    })
  }

  if (source.name && !('name' in target)) {
    Object.defineProperty(target, 'name', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: source.name,
    })
  }

  if (source.message && !('message' in target)) {
    Object.defineProperty(target, 'message', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: source.message,
    })
  }
}

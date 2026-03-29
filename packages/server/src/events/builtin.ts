import { Event } from './Event'

/**
 * Emitted when an HTTP request is received.
 */
export class RequestReceived extends Event {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly requestId?: string
  ) {
    super()
  }
}

/**
 * Emitted when an HTTP request has finished processing.
 */
export class RequestFinished extends Event {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly durationMs: number,
    public readonly requestId?: string
  ) {
    super()
  }
}

/**
 * Emitted when a user successfully authenticates.
 */
export class UserAuthenticated extends Event {
  constructor(
    public readonly userId: string | number,
    public readonly guard: string = 'default'
  ) {
    super()
  }
}

/**
 * Emitted when a user logs out.
 */
export class UserLoggedOut extends Event {
  constructor(
    public readonly userId: string | number,
    public readonly guard: string = 'default'
  ) {
    super()
  }
}

/**
 * Emitted when a queued job is successfully processed.
 */
export class JobProcessed extends Event {
  constructor(
    public readonly jobId: string,
    public readonly jobName: string,
    public readonly queue: string,
    public readonly durationMs: number
  ) {
    super()
  }
}

/**
 * Emitted when a queued job fails.
 */
export class JobFailed extends Event {
  constructor(
    public readonly jobId: string,
    public readonly jobName: string,
    public readonly queue: string,
    public readonly error: Error,
    public readonly attempts: number
  ) {
    super()
  }
}

/**
 * Emitted when the application starts.
 */
export class ApplicationStarted extends Event {
  constructor(
    public readonly port: number,
    public readonly host: string
  ) {
    super()
  }
}

/**
 * Emitted when the application is shutting down.
 */
export class ApplicationShutdown extends Event {
  constructor(public readonly reason?: string) {
    super()
  }
}

import { Event } from './Event'

export class RequestReceived extends Event {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly requestId?: string
  ) {
    super()
  }
}

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

export class UserAuthenticated extends Event {
  constructor(
    public readonly userId: string | number,
    public readonly guard: string = 'default'
  ) {
    super()
  }
}

export class UserLoggedOut extends Event {
  constructor(
    public readonly userId: string | number,
    public readonly guard: string = 'default'
  ) {
    super()
  }
}

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

export class ApplicationStarted extends Event {
  constructor(
    public readonly port: number,
    public readonly host: string
  ) {
    super()
  }
}

export class ApplicationShutdown extends Event {
  constructor(public readonly reason?: string) {
    super()
  }
}

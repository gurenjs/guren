/**
 * Thrown by findOrFail/firstOrFail. Carries `statusCode` 404 so exception
 * handlers can render it without coupling to the ORM package.
 */
export class ModelNotFoundException extends Error {
  readonly statusCode = 404
  readonly modelName: string
  readonly modelId: unknown

  constructor(modelName: string, id?: unknown, key = 'id') {
    super(id === undefined ? `${modelName} not found` : `${modelName} not found for ${key}=${String(id)}`)
    this.name = 'ModelNotFoundException'
    this.modelName = modelName
    this.modelId = id
  }
}

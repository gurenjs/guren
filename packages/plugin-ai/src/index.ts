/**
 * `@guren/plugin-ai`: in-process AI agents (RFC 0029). An `Agent` calls a model
 * configured in `config/ai.ts` and reaches the application only through
 * `appTools()`, which runs every call through the agent invocation pipeline.
 */
export { Agent, agent, resolveAgentName } from './agent'
export type {
  AgentClass,
  AgentPrincipalInput,
  AgentResponse,
  AnonymousAgentOptions,
  BoundAgent,
  InferAgentOutput,
  PromptOptions,
} from './agent'

export { appToolDefinitions, appTools, DEFAULT_IN_PROCESS_CALLS_PER_MINUTE } from './app-tools'
export type { AppToolDefinition, AppToolDenial, AppToolError } from './app-tools'

export { defineAiConfig } from './config'
export type { AiConfig, AiConfigDefinition, AiProviderConfig, InferProviders } from './config'

export { ConfiguredAiManager } from './manager'
export type { AiManager, BoundAgentFactory } from './manager'

export { aiPlugin } from './plugin'
export type { AiPluginConfig } from './plugin'

export type {
  AgentToolName,
  AgentToolScope,
  AiAgentName,
  AiAgents,
  AiProviderName,
  AiProviders,
  AppAgentTools,
} from './types'

// What an agent class file needs from the AI SDK, so it imports one package.
export { Output, stepCountIs, tool } from 'ai'

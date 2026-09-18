/**
 * `@guren/plugin-ai`: in-process AI agents (RFC 0029). An `Agent` calls a model
 * configured in `config/ai.ts` and reaches the application only through
 * `appTools()`, which runs every call through the agent invocation pipeline.
 */
export { Agent, agent, bindAgent, resolveAgentName } from './agent'
export type {
  AgentClass,
  AgentPrincipalInput,
  AgentResponse,
  AnonymousAgentOptions,
  AppTools,
  BoundAgent,
  InferAgentOutput,
  PromptOptions,
  QueuedAgentRun,
  QueueOptions,
} from './agent'

export { ChatTurnSchema } from './chat'
export { AGENT_CHUNK_EVENT } from './protocol'

export { appToolDefinitions, appTools } from './app-tools'
export type { AppToolDefinition, AppToolDenial, AppToolError } from './app-tools'

export { DatabaseConversationStore, MemoryConversationStore } from './conversations'
export type { ConversationDrivers, ConversationsConfig, ConversationStore, StoredConversation } from './conversations'

export { defineAiConfig } from './config'
export type { AiConfig, AiConfigDefinition, AiProviderConfig, InferProviders } from './config'

export type { AiManager, BoundAgentFactory } from './manager'

export { AgentResponded, RunAgentJob } from './queue'
export type { QueuedAgentResponse, RunAgentPayload } from './queue'

export { aiPlugin } from './plugin'
export type { AiPluginConfig } from './plugin'

export type {
  AgentToolInput,
  AgentToolName,
  AgentToolOutput,
  AgentToolScope,
  AiAgentName,
  AiAgents,
  AiProviderName,
  AiPricing,
  AiProviders,
  AppAgentTools,
  Granted,
} from './types'

// What an agent class file needs from the AI SDK, so it imports one package.
export { Output, stepCountIs, tool } from 'ai'

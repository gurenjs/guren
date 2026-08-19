export { makeController } from './make-controller'
export { makeMigration } from './make-migration'
export type { MakeMigrationOptions, MakeMigrationResult } from './make-migration'
export { makeModel } from './make-model'
export { makeView } from './make-view'
export { makeRoute } from './make-route'
export { makeTest } from './make-test'
export { makeAuth } from './make-auth'
export { getBlueprint, listBlueprints, runBlueprint } from './blueprints'
export { runDatabaseMigrations, runDatabaseSeeders } from './db-migrate'
export type { MigrationRunSummary, SeederRunSummary, ResetRunSummary } from './db-migrate'
export { generateRouteTypes } from './routes-types'
export { generatePageTypes } from './pages-types'
export { generateDataTypes } from './data-types'
export { generateChannelTypes } from './channel-types'
export { generateApiClientTypes } from './api-client-types'
export { generateOpenApiSpec, loadOpenApiModule, resolveOpenApiInfo } from './openapi-generate'
export { runDoctor, renderDoctorReport, suggestNextSteps, buildJsonOutput } from './doctor'
export { upgradeCanary, DEFAULT_UPGRADE_TAG } from './upgrade'
export { scaffoldDeploy } from './deploy'
export { installPlugin } from './plugin'
export { routeTypesPlugin } from './vite/route-types'
export { generateKeyValue } from './key-generate'
export { installAgentHarness } from './agent-harness'
export type { AgentHarnessMode, AgentHarnessOptions, AgentHarnessResult } from './agent-harness'
export type { AgentTarget } from './agent-targets'
export type { WriterOptions } from './utils'
export type { TestRunner } from './make-test'
export type { BlueprintDefinition, RunBlueprintOptions } from './blueprints'
export type { GenerateRouteTypesOptions } from './routes-types'
export type { GeneratePageTypesOptions, PageDefinition } from './pages-types'
export type { GenerateDataTypesOptions, ResourceDefinition } from './data-types'
export type { GenerateChannelTypesOptions } from './channel-types'
export type { GenerateApiClientOptions, ResourceTypeRef } from './api-client-types'
export type { GenerateOpenApiSpecOptions, GenerateOpenApiSpecResult } from './openapi-generate'
export type { DoctorCheck, DoctorReport, DoctorStatus, DoctorJsonOutput, RunDoctorOptions, NextStep } from './doctor'

// AI Agent commands
export { generateContext, renderContextMarkdown, displayContext } from './context'
export {
  generateEntityContext,
  renderEntityContextMarkdown,
  displayEntityContext,
  EntityResolutionError,
  type EntityContext,
  type EntityContextOptions,
} from './entity-context'
export { routeDefinitionToContextRoute, loadContextRoutes, type ContextRoute } from './context-route'
export { createFreshContextApi } from './fresh-context'
export {
  scanDocs,
  parseDocFrontmatter,
  extractDocsTags,
  extractMarkdownLinks,
  type DocRef,
  type DocActorEvent,
} from './docs-index'
export { runDocsCheck } from './docs-check'
// The docs relation graph, exposed for `guren docs:graph` and the MCP
// tool of the same shape.
export {
  buildDocsGraphReport,
  renderDocsGraphMarkdown,
  type DocsGraphReport,
  type DocsGraphReportOptions,
  type DocsGraphQuery,
  type DocsGraph,
  type DocsGraphNode,
  type DocsGraphEdge,
} from './docs-graph'
// The docs viewer's server-side half calls exactly these two (see
// DocsViewerCliApi); the graph builder and renderer behind them stay
// package-internal.
export {
  buildDocsViewerData,
  docsViewerAssetPath,
  type DocsViewerData,
  type DocsViewerDoc,
  type DocTrustTier,
} from './docs-viewer'
export {
  generateSpecArtifacts,
  writeSpecArtifacts,
  SPEC_DIR,
  type SpecArtifact,
} from './spec-generate'
export { runSpecCheck } from './spec-check'
export { parseSchemaTables, parseSchemaTableColumns, type SchemaTable, type SchemaColumn } from './schema-parser'
export { runCheck, renderCheckReport } from './check'
export { generateGuidelines } from './guidelines'
export { listModels, displayModels } from './model-list'
export { makeFeature } from './make-feature'
export { parseFieldsString } from './fields'
export { parseModelFile, parseModelSource } from './model-parser'
export { collectFiles, discoverModelFiles, discoverControllerFiles, classNameFromPath, excludeBarrelFiles } from './discovery'
export type { ProjectContext, ContextOptions } from './context'
export type { CheckReport, CheckResult, CheckStatus, RunCheckOptions } from './check'
export type { GuidelinesOptions } from './guidelines'
export type { ModelListOptions } from './model-list'
export type { ModelInfo, ModelRelationship } from './model-parser'
export type { MakeFeatureOptions } from './make-feature'
export type { FieldDefinition } from './fields'
export type { UpgradeCanaryOptions, UpgradeCanaryResult, UpgradedDependency } from './upgrade'
export type { DeployOptions, DeployTarget } from './deploy'
export type { InstallPluginOptions } from './plugin'
export type { RouteTypesPluginOptions } from './vite/route-types'

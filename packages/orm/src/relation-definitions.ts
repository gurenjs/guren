import type { Model } from './Model'

interface BaseRelationDefinition {
  type: 'hasMany' | 'hasOne' | 'belongsTo' | 'belongsToMany' | 'hasManyThrough' | 'morphMany' | 'morphTo'
  name: string
  related: typeof Model | (() => typeof Model | Promise<typeof Model>)
}

export interface HasManyRelationDefinition extends BaseRelationDefinition {
  type: 'hasMany'
  foreignKey: string
  localKey: string
}

export interface HasOneRelationDefinition extends BaseRelationDefinition {
  type: 'hasOne'
  foreignKey: string
  localKey: string
}

export interface BelongsToRelationDefinition extends BaseRelationDefinition {
  type: 'belongsTo'
  foreignKey: string
  ownerKey: string
}

export interface BelongsToManyRelationDefinition extends BaseRelationDefinition {
  type: 'belongsToMany'
  pivotTable: unknown
  foreignPivotKey: string
  relatedPivotKey: string
  parentKey: string
  relatedKey: string
}

export interface HasManyThroughRelationDefinition extends BaseRelationDefinition {
  type: 'hasManyThrough'
  through: typeof Model | (() => typeof Model | Promise<typeof Model>)
  firstKey: string
  secondKey: string
  localKey: string
  secondLocalKey: string
}

export type RelationDefinition =
  | HasManyRelationDefinition
  | HasOneRelationDefinition
  | BelongsToRelationDefinition
  | BelongsToManyRelationDefinition
  | HasManyThroughRelationDefinition
  | MorphManyRelationDefinition
  | MorphToRelationDefinition

export interface MorphManyRelationDefinition extends BaseRelationDefinition {
  type: 'morphMany'
  morphName: string
  localKey: string
}

export interface MorphToRelationDefinition {
  type: 'morphTo'
  name: string
  related: undefined
  morphName: string
}

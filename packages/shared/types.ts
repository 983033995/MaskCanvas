export interface Point { x: number; y: number }
export type Shape = (
  | { type: 'rect'; x: number; y: number; width: number; height: number }
  | { type: 'brush'; points: Point[]; radius: number }
  | { type: 'polygon'; points: Point[] }
) & { subtract?: boolean };
/** Original-pixel context may be provided to an editor; it never grants edit permission. */
export interface RegionContext { x: number; y: number; width: number; height: number }
export interface Region {
  id: string;
  name: string;
  kind: 'edit' | 'keep';
  intent: string;
  feather: number;
  shapes: Shape[];
  context?: RegionContext;
}
export interface Validation {
  protectedChangedPixels: number;
  outsideEditChangedPixels: number;
  changedPixels: number;
  maxChannelDelta: number;
  passed: boolean;
}
export interface Version {
  id: string;
  name: string;
  asset: string;
  status: 'source' | 'candidate' | 'accepted' | 'rejected';
  createdAt: string;
  baseVersionId?: string;
  annotationRevision?: number;
  regionId?: string;
  regionIds?: string[];
  stale?: boolean;
  validation?: Validation;
}
export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  baseVersionId: string;
  regions: Region[];
  versions: Version[];
}
export interface ProjectSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  revision: number;
  updatedAt: string;
  baseAsset: string;
  versionCount: number;
  regionCount: number;
}
export interface AnnotationDocument {
  format: 'maskcanvas.annotations';
  schemaVersion: 1;
  projectId: string;
  baseVersionId: string;
  revision: number;
  image: {
    assetUri: string;
    sha256: string;
    width: number;
    height: number;
    colourSpace: 'srgb';
    coordinates: 'original-pixels';
  };
  regions: Region[];
}
export type ImageBackend = 'qwen' | 'gpt';
export interface ProcessingTarget { destination: string; modelId: string }
export interface ProposalSuggestion {
  regionId: string;
  reason: string;
  enabled: boolean;
  confidence?: number;
}
export interface EditProposal {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  source: 'agent' | 'human';
  backend: ImageBackend;
  baseVersionId: string;
  projectRevision: number;
  revision: number;
  status: 'draft' | 'confirmed' | 'stale' | 'cancelled';
  regions: Region[];
  suggestions: ProposalSuggestion[];
  createdAt: string;
  updatedAt: string;
  confirmation?: {
    id: string;
    confirmedAt: string;
    proposalRevision: number;
    projectRevision: number;
    baseVersionId: string;
    fingerprint: string;
    processing?: ProcessingTarget;
  };
}
export interface ProposalInput {
  title: string;
  goal: string;
  backend: ImageBackend;
  source: 'agent' | 'human';
  baseVersionId: string;
  projectRevision: number;
  regions: Region[];
  suggestions: ProposalSuggestion[];
}
export interface Capabilities {
  localCore: boolean;
  qwen: { available: boolean; reason: string };
  gpt: { available: boolean; reason: string; destination?: string; modelId?: string };
  vision: { available: boolean; reason: string };
}
export interface Job {
  id: string;
  projectId: string;
  regionId: string;
  baseVersionId: string;
  annotationRevision: number;
  status: 'queued' | 'running' | 'reconciling' | 'candidate' | 'failed' | 'cancelled';
  externalId?: string;
  versionId?: string;
  error?: string;
  waitReason?: string;
  proposalId?: string;
  confirmationId?: string;
  regionIds?: string[];
  /** Zero-based active step; terminal jobs retain the last actual step index. */
  stepIndex?: number;
  stepCount?: number;
  completedStepCount?: number;
  source?: 'agent' | 'human';
  submissionMode?: 'manual-region' | 'confirmed-plan';
  backend?: ImageBackend;
  destination?: string;
  modelId?: string;
  grantId?: string;
  createdAt: string;
  updatedAt: string;
}

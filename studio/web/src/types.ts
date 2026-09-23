export interface Frame {
  id: string;
  duration: number;
  offset: [number, number];
  /** Mirror the image horizontally (applied before the offset). */
  flipX?: boolean;
  version: number;
  versions: number[];
  note: string;
}

export type Playback = 'loop' | 'pingpong';

export interface Action {
  id: string;
  label: string;
  cellSize: number;
  grounded: boolean;
  playback: Playback;
  frames: Frame[];
  nextSeq: number;
  source?: string;
  updatedAt?: number;
}

export interface ActionSummary {
  id: string;
  label: string;
  cellSize: number;
  frameCount: number;
  duration: number;
  thumb: string | null;
}

export interface Project {
  id: string;
  name: string;
  references: string[];
  actionOrder: string[];
  identityReference?: string | null;
  designReference?: string | null;
  actions: ActionSummary[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  thumb: string | null;
  actionCount: number;
}

export type ReferenceRole = 'identity' | 'design';

export type ExportFormat = 'gif' | 'webp' | 'apng' | 'sheet';

export interface ExportOptions {
  format: ExportFormat;
  scale: number;
  background: string;
  matte: string;
  alphaThreshold: number;
  trim: boolean;
  padding: number;
}

export interface ExportResult {
  file: string;
  url: string;
  bytes: number;
  frames: number;
  width: number;
  height: number;
  totalDuration: number;
}

export type JobKind = 'redraw' | 'repair' | 'inbetween' | 'keyposes' | 'master' | 'turnaround';
export type FrameJobKind = 'redraw' | 'repair' | 'inbetween';
export type Facing = 'front' | 'right' | 'left';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type Rect = [number, number, number, number];

export interface Candidate {
  index: number;
  status: JobStatus;
  image: string | null;
  /** keyposes: one image per pose */
  frames?: string[];
  error: string | null;
  startedAt?: number;
  finishedAt?: number;
}

export interface Job {
  id: string;
  kind: JobKind;
  action: string;
  /** null for action-level jobs (keyposes) */
  frame: string | null;
  /** inbetween: the frame the new one goes before */
  frameB?: string | null;
  cellSize: number;
  sourceVersion?: number;
  flipX?: boolean;
  offset?: [number, number];
  instruction: string;
  rect?: Rect | null;
  keyframes?: number;
  grid?: [number, number];
  facing?: Facing;
  duration?: number;
  model: string;
  status: JobStatus;
  reviewed: boolean;
  createdAt: number;
  finishedAt?: number;
  candidates: Candidate[];
  accepted: { index: number; version?: number; frames?: string[]; reference?: string }[];
  sources?: string[];
}

export type ReferenceStyle = 'pixel' | 'source';

export interface ReferenceJobRequest {
  kind: 'master' | 'turnaround';
  sources: string[];
  instruction: string;
  style: ReferenceStyle;
  styleFrom?: string | null;
  candidates: number;
}

export type AcceptResult =
  | { kind: 'redraw' | 'repair'; action: string; frame: string; version: number }
  | { kind: 'inbetween'; action: string; frame: Frame; after: string }
  | { kind: 'keyposes'; action: string; frames: Frame[] }
  | { kind: 'master' | 'turnaround'; reference: string; project: Project };

export interface NewActionRequest {
  id: string;
  label: string;
  cellSize: number;
  grounded: boolean;
  playback: Playback;
}

export interface ActionSuggestion {
  id: string;
  label: string;
  description: string;
  keyframes: number;
  facing: Facing;
  grounded: boolean;
  playback: Playback;
  duration: number;
}

export interface KeyposeRequest {
  instruction: string;
  keyframes: number;
  facing: Facing;
  candidates: number;
  duration: number;
}

export type Provider = 'codex' | 'api';

export interface GeneratorSettings {
  provider: Provider;
  api: { base: string; model: string; textModel: string; quality: string; timeout: number; hasKey: boolean; keyHint: string };
  codex: CodexStatus;
}

export interface GeneratorSettingsPatch {
  provider?: Provider;
  api?: { base?: string; key?: string; clearKey?: boolean; model?: string; textModel?: string; quality?: string; timeout?: number };
}

export interface CodexStatus {
  available: boolean;
  version: string | null;
  model: string;
}

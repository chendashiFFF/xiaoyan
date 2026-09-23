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
  actions: ActionSummary[];
}

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

export type JobKind = 'redraw' | 'repair';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type Rect = [number, number, number, number];

export interface Candidate {
  index: number;
  status: JobStatus;
  image: string | null;
  error: string | null;
  startedAt?: number;
  finishedAt?: number;
}

export interface Job {
  id: string;
  kind: JobKind;
  action: string;
  frame: string;
  cellSize: number;
  sourceVersion: number;
  flipX: boolean;
  instruction: string;
  rect: Rect | null;
  model: string;
  status: JobStatus;
  reviewed: boolean;
  createdAt: number;
  finishedAt?: number;
  candidates: Candidate[];
  accepted: { index: number; version: number }[];
}

export interface CodexStatus {
  available: boolean;
  version: string | null;
  model: string;
}

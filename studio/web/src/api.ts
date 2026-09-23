import type { AcceptResult, Action, CodexStatus, ExportOptions, ExportResult, Frame, FrameJobKind, Job, KeyposeRequest, NewActionRequest, Project, ProjectSummary, Rect, ReferenceJobRequest, ReferenceRole, GeneratorSettings, GeneratorSettingsPatch } from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch {
      // Non-JSON error bodies keep the status text.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  listProjects: () => request<ProjectSummary[]>('/api/projects'),
  createProject: (body: { id: string; name: string }) => request<Project>('/api/projects', json('POST', body)),
  deleteProject: (pid: string) => request<{ trashedTo: string; next: string }>(`/api/projects/${pid}`, { method: 'DELETE' }),
  updateProject: (pid: string, patch: { name?: string; identityReference?: string | null; designReference?: string | null }) =>
    request<Project>(`/api/projects/${pid}`, json('PATCH', patch)),
  uploadReference: (pid: string, file: File, role: ReferenceRole | null) =>
    request<{ reference: string; warning: string | null; project: Project }>(
      `/api/projects/${pid}/references?${new URLSearchParams({ ...(role ? { role } : {}), name: file.name })}`,
      { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file },
    ),
  getProject: (pid: string) => request<Project>(`/api/projects/${pid}`),
  getAction: (pid: string, aid: string) => request<Action>(`/api/projects/${pid}/actions/${aid}`),
  saveAction: (pid: string, action: Action) =>
    request<Action>(`/api/projects/${pid}/actions/${action.id}`, json('PUT', action)),
  duplicateFrame: (pid: string, aid: string, frame: Frame) =>
    request<Pick<Frame, 'id' | 'version' | 'versions'>>(
      `/api/projects/${pid}/actions/${aid}/frames/${frame.id}/duplicate`,
      json('POST', { version: frame.version }),
    ),
  uploadVersion: (pid: string, aid: string, fid: string, file: Blob) =>
    request<{ version: number }>(`/api/projects/${pid}/actions/${aid}/frames/${fid}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }),
  exportAction: (pid: string, aid: string, options: ExportOptions) =>
    request<ExportResult>(`/api/projects/${pid}/actions/${aid}/export`, json('POST', options)),
  codexStatus: () => request<CodexStatus>('/api/codex'),
  getSettings: () => request<GeneratorSettings>('/api/settings'),
  updateSettings: (patch: GeneratorSettingsPatch) => request<GeneratorSettings>('/api/settings', json('PUT', patch)),
  testSettings: (api: GeneratorSettingsPatch['api']) =>
    request<{ ok: boolean; error?: string; models: string[]; hasModel?: boolean }>('/api/settings/test', json('POST', { api })),
  createReferenceJob: (pid: string, body: ReferenceJobRequest) => request<Job>(`/api/projects/${pid}/reference-jobs`, json('POST', body)),
  listReferenceJobs: (pid: string) => request<Job[]>(`/api/projects/${pid}/reference-jobs`),
  createAction: (pid: string, body: NewActionRequest) => request<Action>(`/api/projects/${pid}/actions`, json('POST', body)),
  deleteAction: (pid: string, aid: string) => request<{ trashedTo: string }>(`/api/projects/${pid}/actions/${aid}`, { method: 'DELETE' }),
  createKeyposes: (pid: string, aid: string, body: KeyposeRequest) =>
    request<Job>(`/api/projects/${pid}/actions/${aid}/jobs`, json('POST', { kind: 'keyposes', ...body })),
  createJob: (pid: string, aid: string, fid: string, body: { kind: FrameJobKind; instruction: string; candidates: number; rect?: Rect | null }) =>
    request<Job>(`/api/projects/${pid}/actions/${aid}/frames/${fid}/jobs`, json('POST', body)),
  listJobs: (pid: string, aid: string) => request<Job[]>(`/api/projects/${pid}/actions/${aid}/jobs`),
  cancelJob: (pid: string, jid: string) => request<Job>(`/api/projects/${pid}/jobs/${jid}/cancel`, json('POST', {})),
  reviewJob: (pid: string, jid: string, reviewed: boolean) =>
    request<Job>(`/api/projects/${pid}/jobs/${jid}/review`, json('POST', { reviewed })),
  acceptCandidate: (pid: string, jid: string, index: number) =>
    request<AcceptResult>(`/api/projects/${pid}/jobs/${jid}/candidates/${index}/accept`, json('POST', {})),
};

export function candidateUrl(pid: string, job: Job, index: number): string {
  return `/files/${pid}/jobs/${job.id}/cand-${index}.png`;
}

export function jobFileUrl(pid: string, job: Job, name: string): string {
  return `/files/${pid}/jobs/${job.id}/${name}`;
}

export function projectFileUrl(pid: string, rel: string): string {
  return `/files/${pid}/${rel}`;
}

export function frameUrl(pid: string, aid: string, fid: string, version: number): string {
  return `/files/${pid}/actions/${aid}/frames/${fid}/v${version}.png`;
}

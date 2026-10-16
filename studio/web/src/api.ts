import type { ExportJob, Library, Upload, VideoDoc, Typography, ArtJob, GeneratorSettings } from './types';
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.detail;
    throw new Error(Array.isArray(detail) ? detail.map((d: { msg: string }) => d.msg.replace('Value error, ', '')).join('；') : detail || `请求失败 (${response.status})`);
  }
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const api = {
  library: () => request<Library>('/api/music/library'),
  document: () => request<VideoDoc>('/api/music/document'),
  save: (doc: VideoDoc) => request<{ savedAt: number }>('/api/music/document', json('PUT', doc)),
  upload: (kind: string, file: File) => request<Upload>(`/api/music/uploads/${kind}?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file }),
  export: (doc: VideoDoc) => request<ExportJob>('/api/music/exports', json('POST', doc)),
  job: (id: string) => request<ExportJob>(`/api/music/exports/${id}`),
  templates: () => request<{ name: string; style: Partial<VideoDoc> }[]>('/api/music/templates'),
  saveTemplate: (name: string, style: Partial<VideoDoc>) => request<{ name: string; style: Partial<VideoDoc> }>('/api/music/templates', json('POST', { name, style })),
  typography: (doc: VideoDoc) => request<Typography>('/api/music/typography', json('POST', doc)),
  art: (document: VideoDoc, brief: string, kind: string) => request<ArtJob>('/api/music/art', json('POST', { document, brief, kind })),
  artStatus: (id: string) => request<ArtJob>(`/api/music/art/${id}`),
  settings: () => request<GeneratorSettings>('/api/settings'),
  saveSettings: (body: unknown) => request<GeneratorSettings>('/api/settings', json('PUT', body)),
  waveform: (name: string) => request<{ peaks: number[] }>(`/api/music/waveform/${encodeURIComponent(name)}`),
  cancel: (id: string) => request<ExportJob>(`/api/music/exports/${id}/cancel`, { method: 'POST' }),
};

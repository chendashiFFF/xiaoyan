import { useState } from 'react';
import type { Project, ProjectSummary, ReferenceRole } from '../types';
import { api } from '../api';
import { ReferenceGenerator } from './ReferenceGenerator';
interface Props {
  project: Project; fileUrl: (rel: string) => string; onClose: () => void;
  onUpload: (file: File, role: ReferenceRole) => Promise<string | null>;
  onAssign: (role: ReferenceRole, rel: string | null) => Promise<void>;
  projects: ProjectSummary[]; initialSources?: string[];
  onUploadSource: (file: File) => Promise<string>; onProjectChange: (project: Project) => void;
}
const angles = { unknown: '未标记', front: '正面', quarter: '正面偏转', side: '侧面', back: '背面', detail: '细节／三视图' };
export function ReferencesDialog({ project, fileUrl, onClose, projects, initialSources, onUploadSource, onProjectChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>) => { setBusy(true); setError(null); try { await work(); } catch(e) { setError(String(e)); } finally { setBusy(false); } };
  const patch = async (body: Parameters<typeof api.updateProject>[1]) => onProjectChange(await api.updateProject(project.id, body));
  const upload = (files: File[]) => run(async () => { for (const file of files) await onUploadSource(file); });
  return <div className="modal-backdrop" onClick={onClose}><div className="modal refs-modal" role="dialog" aria-label="人物参考图库" onClick={e => e.stopPropagation()}>
    <header><h2>「{project.name}」的参考图库</h2><button onClick={onClose}>关闭</button></header>
    <p>上传原图后即可生成动作。默认启用的图片都会参与生成，角度可自行标记。移除图片不会删除历史任务中的快照。</p>
    <div className="reference-upload" tabIndex={0} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) void upload([...e.dataTransfer.files]); }} onPaste={e => { if (!busy && e.clipboardData.files.length) { e.preventDefault(); void upload([...e.clipboardData.files]); } }}>
      <label>添加参考图（可多选、拖入或粘贴）<input type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void upload(files); }} /></label>
    </div>
    <div className="reference-library">{project.references.map(rel => {
      const meta = project.referenceSettings?.[rel] ?? { angle: 'unknown', enabled: true };
      const update = (changes: Partial<typeof meta>) => run(() => patch({ referenceSettings: { ...project.referenceSettings, [rel]: { ...meta, ...changes } } }));
      return <section className="ref-card" key={rel}><div className="ref-preview checker"><img src={fileUrl(rel)} alt="人物参考图" /></div>
        <select aria-label="图片角度" disabled={busy} value={meta.angle} onChange={e => void update({ angle: e.target.value })}>{Object.entries(angles).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <label><input type="checkbox" disabled={busy} checked={meta.enabled} onChange={e => void update({ enabled: e.target.checked })} />默认用于生成</label>
        <div className="row"><button disabled={busy} onClick={() => void run(() => patch({ identityReference: rel }))}>{project.identityReference === rel ? '✓ 尺寸基准' : '设为尺寸基准'}</button>
        <button disabled={busy} onClick={() => void run(() => patch({ removeReference: rel }))}>移除</button></div>
      </section>;
    })}</div>
    <label>默认道具选项 <select disabled={busy} value={project.propMode ?? 'keep'} onChange={e => void run(() => patch({ propMode: e.target.value as Project['propMode'] }))}><option value="keep">保留道具</option><option value="character">只参考人物</option></select></label>
    {error && <p className="error">{error}</p>}
    <details><summary>可选：生成规范图或三视图</summary><ReferenceGenerator project={project} projects={projects} fileUrl={fileUrl} initialSources={initialSources} onUploadSource={onUploadSource} onProjectChange={onProjectChange} /></details>
  </div></div>;
}

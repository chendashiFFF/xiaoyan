import type { Project } from '../types';
import { projectFileUrl } from '../api';
export interface ReferenceChoice { references: string[]; propMode: 'keep' | 'character' }
export function defaultChoice(project: Project): ReferenceChoice {
  return { references: project.references.filter(r => project.referenceSettings?.[r]?.enabled !== false), propMode: project.propMode ?? 'keep' };
}
export function ReferenceSelection({ project, value, onChange }: { project: Project; value: ReferenceChoice; onChange: (value: ReferenceChoice) => void }) {
  return <section className="generation-references"><strong>本次参考图片 · {value.references.length} 张</strong>
    <div className="reference-strip">{project.references.map(rel => <label key={rel} className="reference-choice">
      <img src={projectFileUrl(project.id, rel)} alt="人物参考图" />
      <span><input type="checkbox" checked={value.references.includes(rel)} onChange={e => onChange({ ...value, references: e.target.checked ? [...value.references, rel] : value.references.filter(r => r !== rel) })} />使用</span>
    </label>)}</div>
    {!value.references.length && <p className="error">请至少选择一张参考图后生成。</p>}
    <select aria-label="本次道具选项" value={value.propMode} onChange={e => onChange({ ...value, propMode: e.target.value as ReferenceChoice['propMode'] })}><option value="keep">保留参考图中的道具</option><option value="character">只参考人物，不带原图道具</option></select>
    <p className="muted hint">适用于新动作、重绘、修帧和批量补帧；所有勾选图片都会发送，服务超限时会显示错误，不会静默丢图。</p>
  </section>;
}

export function JobReferences({ pid, job }: { pid: string; job: import('../types').Job }) {
  if (!job.referenceSnapshots) return null;
  const labels: Record<string, string> = { unknown: '未标记', front: '正面', quarter: '正面偏转', side: '侧面', back: '背面', detail: '细节／三视图' };
  return <details><summary>生成时参考了 {job.referenceSnapshots.length} 张原图 · {job.propMode === 'character' ? '只参考人物' : '保留道具'}</summary><div className="reference-strip">{job.referenceSnapshots.map(r => <a className="reference-choice" key={r.snapshot} href={projectFileUrl(pid, `jobs/${job.id}/${r.snapshot}`)} target="_blank" rel="noreferrer"><img src={projectFileUrl(pid, `jobs/${job.id}/${r.snapshot}`)} alt={labels[r.angle] ?? r.angle} /><span>{labels[r.angle] ?? r.angle}</span></a>)}</div></details>;
}

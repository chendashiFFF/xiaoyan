import { useCallback, useEffect, useRef, useState } from 'react';
import { api, candidateUrl } from '../api';
import type { Job, Project, ProjectSummary } from '../types';

interface Props {
  project: Project;
  projects: ProjectSummary[];
  fileUrl: (rel: string) => string;
  initialSources?: string[];
  onUploadSource: (file: File) => Promise<string>;
  onProjectChange: (project: Project) => void;
}

const STATUS: Record<Job['status'], string> = { queued: '排队中', running: '生成中', done: '已完成', failed: '失败', cancelled: '已取消' };
const active = (job: Job) => job.status === 'queued' || job.status === 'running';

export function ReferenceGenerator({ project, projects, fileUrl, initialSources, onUploadSource, onProjectChange }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<string[]>(initialSources ?? []);
  const [notes, setNotes] = useState('');
  const [style, setStyle] = useState('pixel');
  const [count, setCount] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setJobs(await api.listReferenceJobs(project.id));
    } catch {
      // keep the previous list; the next poll retries
    }
  }, [project.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  const anyActive = jobs.some(active);
  useEffect(() => {
    if (!anyActive) return undefined;
    const timer = window.setInterval(() => { void refresh(); setNow(Date.now()); }, 2000);
    return () => window.clearInterval(timer);
  }, [anyActive, refresh]);

  const guard = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (kind: 'master' | 'turnaround') => guard(async () => {
    const fromOther = style.startsWith('from:');
    const job = await api.createReferenceJob(project.id, {
      kind,
      sources: kind === 'master' ? selected : [],
      instruction: notes,
      style: fromOther ? 'pixel' : (style as 'pixel' | 'source'),
      styleFrom: fromOther ? style.slice(5) : null,
      candidates: count,
    });
    setJobs((prev) => [job, ...prev]);
  });

  const accept = (job: Job, index: number) => guard(async () => {
    const result = await api.acceptCandidate(project.id, job.id, index);
    if (result.kind === 'master' || result.kind === 'turnaround') onProjectChange(result.project);
    await refresh();
  });

  const others = projects.filter((p) => p.id !== project.id && p.thumb);

  return (
    <section className="ref-ai">
      <h3>让 AI 画规范参考图</h3>
      <p className="hint">
        给几张这个人物的图（不同角度、姿势、画风都行），AI 会画成一张<b>正面、站直、全身</b>的主参考图；
        有了主参考图后，还能生成<b>正面 / 侧面 / 背面</b>三视图当设定图。生成后自动去掉背景。
      </p>
      <div className="field">
        <span>素材图（点选要用的，可多选）</span>
        <div className="ref-sources">
          {project.references.map((rel) => (
            <button
              key={rel}
              className={`checker ${selected.includes(rel) ? 'active' : ''}`}
              title={rel}
              onClick={() => setSelected((prev) => (prev.includes(rel) ? prev.filter((r) => r !== rel) : [...prev, rel]))}
            >
              <img src={fileUrl(rel)} alt="" />
              {selected.includes(rel) && <span>✓</span>}
            </button>
          ))}
          <button className="add" disabled={busy} onClick={() => fileRef.current?.click()}>＋ 上传</button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/webp,image/jpeg"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (!files.length) return;
            void guard(async () => {
              for (const file of files) {
                const rel = await onUploadSource(file);
                setSelected((prev) => [...prev, rel]);
              }
            });
          }}
        />
      </div>
      <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="补充说明（可选）：比如 发饰在左边、眼睛是金色、不要戴帽子" />
      <div className="row">
        <label className="inline">画风
          <select value={style} onChange={(e) => setStyle(e.target.value)}>
            <option value="pixel">像素风 HD-2D</option>
            <option value="source">保持素材图的画风</option>
            {others.map((p) => <option key={p.id} value={`from:${p.id}`}>和「{p.name}」同一画风</option>)}
          </select>
        </label>
        <label className="inline">候选
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[1, 2, 3].map((n) => <option key={n} value={n}>{n} 张</option>)}
          </select>
        </label>
      </div>
      <div className="row">
        <button className="primary" disabled={busy || !selected.length} onClick={() => void submit('master')}>生成主参考图</button>
        <button disabled={busy || !project.identityReference} onClick={() => void submit('turnaround')} title="用当前的主参考图画正面、侧面、背面">生成三视图设定图</button>
        <span className="muted hint">每张约 1–2 分钟，消耗生图额度</span>
      </div>
      {error && <p className="error">{error}</p>}

      {jobs.map((job) => {
        const elapsed = Math.max(0, Math.floor(now / 1000 - job.createdAt));
        const errors = [...new Set(job.candidates.map((c) => c.error).filter((e): e is string => Boolean(e) && e !== '已取消'))];
        return (
          <div key={job.id} className={`job ${job.status}`}>
            <div className="job-head">
              <span>{job.kind === 'master' ? '主参考图' : '三视图'} · {STATUS[job.status]}{active(job) ? ` ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` : ''}</span>
              {active(job) && <button onClick={() => void guard(async () => { await api.cancelJob(project.id, job.id); await refresh(); })}>取消</button>}
            </div>
            {job.instruction && <p className="job-text">{job.instruction}</p>}
            <div className="ref-cands">
              {job.candidates.map((c) => {
                const accepted = job.accepted.find((a) => a.index === c.index);
                return c.status === 'done' ? (
                  <figure key={c.index}>
                    <div className={`checker ${job.kind === 'turnaround' ? 'wide' : ''}`}><img src={candidateUrl(project.id, job, c.index)} alt="" /></div>
                    <button className={accepted ? '' : 'primary'} disabled={busy || Boolean(accepted)} onClick={() => void accept(job, c.index)}>
                      {accepted ? '已使用' : job.kind === 'master' ? '设为主参考图' : '设为设定图'}
                    </button>
                  </figure>
                ) : (
                  <div key={c.index} className={`cand placeholder ${c.status}`} title={c.error ?? ''}>
                    {c.status === 'running' && <span className="spinner" />}
                    <span>{STATUS[c.status]}</span>
                  </div>
                );
              })}
            </div>
            {errors.length > 0 && <p className="error small">{errors.join('；')}</p>}
          </div>
        );
      })}
    </section>
  );
}

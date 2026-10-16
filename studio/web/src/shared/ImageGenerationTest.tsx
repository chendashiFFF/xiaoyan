import { useEffect, useState } from 'react';
import type { Job } from '../characters/types';

type Result = { project: string; job: Job; source: string };
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || data.error || '请求失败');
  return data;
}
export function ImageGenerationTest({ save, projectId }: { save: () => Promise<unknown>; projectId?: string }) {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = result && ['queued', 'running'].includes(result.job.status);
  useEffect(() => {
    if (!active || !result) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void json<Job>(`/api/projects/${result.project}/jobs/${result.job.id}`).then(job => {
        if (!stopped) { setResult(old => old ? { ...old, job } : old); setError(''); }
      }).catch(err => { if (!stopped) setError(`读取测试进度失败：${String(err)}`); });
    }, 1500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [active, result?.project, result?.job.id]);
  async function run() {
    setBusy(true); setError(''); setResult(null);
    try {
      await save();
      setResult(await json<Result>('/api/settings/test-image', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: projectId }),
      }));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  const candidate = result?.job.candidates.find(item => item.status === 'done' && item.image);
  return <div style={{ marginTop: 12 }}>
    <button disabled={busy || !!active} onClick={() => void run()}>{busy ? '准备测试…' : active ? '正在实际出图…' : '保存并测试出图'}</button>
    <p className="hint">两个工作台共用配置。测试生成 1 张图片，会使用服务额度；结果单独保存，不覆盖原动作。</p>
    {error && <p role="alert" className="error">{error}</p>}
    {result && <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <figure style={{ margin: 0 }}><figcaption>原有人物参考</figcaption><img src={result.source} alt="测试使用的原有人物" style={{ width: 140, height: 140, objectFit: 'contain', imageRendering: 'pixelated' }}/></figure>
      {candidate && <figure style={{ margin: 0 }}><figcaption>实际出图成功</figcaption><img src={`/files/${result.project}/jobs/${result.job.id}/cand-${candidate.index}.png`} alt="实际出图测试结果" style={{ width: 140, height: 140, objectFit: 'contain', imageRendering: 'pixelated' }}/></figure>}
      {['failed', 'cancelled'].includes(result.job.status) && <p role="alert" className="error">{result.job.candidates.map(item => item.error).filter(Boolean).join('；') || '测试未生成图片'}</p>}
    </div>}
  </div>;
}

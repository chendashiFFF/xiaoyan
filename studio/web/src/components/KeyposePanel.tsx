import { useEffect, useState } from 'react';
import type { Action, Facing, Job, KeyposeRequest } from '../types';

interface Props {
  action: Action;
  jobs: Job[];
  fileUrl: (job: Job, name: string) => string;
  onAccept: (job: Job, index: number) => Promise<void>;
  onCancel: (job: Job) => void;
  onGenerate: (request: KeyposeRequest) => Promise<void>;
}

const STATUS: Record<Job['status'], string> = { queued: '排队中', running: '生成中', done: '已完成', failed: '失败', cancelled: '已取消' };
const active = (job: Job) => job.status === 'queued' || job.status === 'running';

/** Cycles through pose images so a key-pose set can be judged as motion, not just as a sheet. */
function PoseLoop({ urls, duration }: { urls: string[]; duration: number }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % urls.length), Math.max(200, duration * 2));
    return () => window.clearInterval(timer);
  }, [urls.length, duration]);
  return <img className="pose-loop" src={urls[index % urls.length]} alt="" />;
}

export function KeyposePanel({ action, jobs, fileUrl, onAccept, onCancel, onGenerate }: Props) {
  const latest = jobs[0];
  const [instruction, setInstruction] = useState(latest?.instruction ?? '');
  const [keyframes, setKeyframes] = useState(latest?.keyframes ?? 4);
  const [facing, setFacing] = useState<Facing>(latest?.facing ?? 'front');
  const [candidates, setCandidates] = useState(1);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const anyActive = jobs.some(active);
  useEffect(() => {
    if (!anyActive) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [anyActive]);
  useEffect(() => {
    if (!instruction && latest?.instruction) setInstruction(latest.instruction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id]);

  const generate = async () => {
    setBusy(true);
    try {
      await onGenerate({ instruction, keyframes, facing, candidates, duration: latest?.duration ?? 150 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="keypose-panel">
      <h2>「{action.label}」还没有帧</h2>
      <p className="muted">先生成关键姿势，挑一组满意的采用，再用右侧的"补中间帧"和"AI 重画"把动作补顺、修好。</p>

      {jobs.map((job) => {
        const elapsed = Math.max(0, Math.floor(now / 1000 - job.createdAt));
        const errors = [...new Set(job.candidates.map((c) => c.error).filter((e): e is string => Boolean(e) && e !== '已取消'))];
        return (
          <div key={job.id} className={`keypose-job job ${job.status}`}>
            <div className="job-head">
              <span>{job.keyframes} 个关键姿势 · {STATUS[job.status]}{active(job) ? ` ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` : ''}</span>
              {active(job) && <button onClick={() => onCancel(job)}>取消</button>}
            </div>
            <p className="job-text">{job.instruction}</p>
            {job.candidates.map((c) => (
              <div key={c.index} className="keypose-candidate">
                {c.status === 'done' && c.frames ? (
                  <>
                    <div className="checker pose-preview"><PoseLoop urls={c.frames.map((name) => fileUrl(job, name))} duration={job.duration ?? 150} /></div>
                    <div className="pose-strip">
                      {c.frames.map((name, k) => (
                        <div key={name} className="checker pose-thumb"><img src={fileUrl(job, name)} alt={`姿势 ${k + 1}`} /><span>{k + 1}</span></div>
                      ))}
                    </div>
                    <button
                      className="primary"
                      disabled={busy || job.accepted.some((a) => a.index === c.index)}
                      onClick={async () => { setBusy(true); try { await onAccept(job, c.index); } finally { setBusy(false); } }}
                    >
                      {job.accepted.some((a) => a.index === c.index) ? '已采用' : `采用第 ${c.index} 组`}
                    </button>
                  </>
                ) : (
                  <div className={`cand placeholder wide ${c.status}`} title={c.error ?? ''}>
                    {c.status === 'running' && <span className="spinner" />}
                    <span>第 {c.index} 组 · {STATUS[c.status]}</span>
                  </div>
                )}
              </div>
            ))}
            {errors.length > 0 && <p className="error small">{errors.join('；')}</p>}
          </div>
        );
      })}

      <div className="keypose-form">
        <h3>{jobs.length ? '不满意？改一下描述再生成' : '生成关键姿势'}</h3>
        <textarea rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="描述动作过程，比如：拿起甜筒、舔一口、眯眼笑、再把甜筒举起来" />
        <div className="row">
          <select value={keyframes} onChange={(e) => setKeyframes(Number(e.target.value))}>
            <option value={4}>4 个姿势</option>
            <option value={6}>6 个姿势</option>
          </select>
          <select value={facing} onChange={(e) => setFacing(e.target.value as Facing)}>
            <option value="front">正面</option>
            <option value="right">朝右</option>
            <option value="left">朝左</option>
          </select>
          <select value={candidates} onChange={(e) => setCandidates(Number(e.target.value))}>
            {[1, 2, 3].map((n) => <option key={n} value={n}>{n} 组</option>)}
          </select>
          <button className="primary" disabled={busy || !instruction.trim()} onClick={generate}>生成</button>
        </div>
      </div>
    </div>
  );
}

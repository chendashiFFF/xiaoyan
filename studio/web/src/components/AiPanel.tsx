import { useEffect, useState } from 'react';
import type { CodexStatus, Frame, Job, JobKind, Rect } from '../types';

export interface PreviewRef {
  jobId: string;
  index: number;
}

interface Props {
  frame: Frame;
  codex: CodexStatus | null;
  jobs: Job[];
  mode: JobKind;
  onMode: (mode: JobKind) => void;
  rect: Rect | null;
  selecting: boolean;
  onToggleSelect: () => void;
  onClearRect: () => void;
  onSubmit: (request: { kind: JobKind; instruction: string; candidates: number }) => Promise<void>;
  preview: PreviewRef | null;
  onPreview: (job: Job, index: number) => void;
  onAccept: (job: Job, index: number) => void;
  onCancel: (job: Job) => void;
  onReview: (job: Job, reviewed: boolean) => void;
  candidateSrc: (job: Job, index: number) => string;
}

const STATUS: Record<Job['status'], string> = { queued: '排队中', running: '生成中', done: '已完成', failed: '失败', cancelled: '已取消' };
const active = (job: Job) => job.status === 'queued' || job.status === 'running';

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function AiPanel(props: Props) {
  const { frame, codex, jobs, mode, rect, selecting, preview } = props;
  const [instruction, setInstruction] = useState('');
  const [count, setCount] = useState(2);
  const [busy, setBusy] = useState(false);
  const [showReviewed, setShowReviewed] = useState(false);
  const now = useNow(jobs.some(active));
  const visible = jobs.filter((job) => showReviewed || !job.reviewed || active(job));
  const hidden = jobs.length - visible.length;
  const unavailable = codex !== null && !codex.available;

  const submit = async () => {
    setBusy(true);
    try {
      await props.onSubmit({ kind: mode, instruction, candidates: count });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ai-panel">
      <h3>AI 重画 <small className="muted">Codex · {codex?.model ?? '…'}</small></h3>
      {unavailable && <p className="error">没有找到 codex 命令。安装并登录 Codex CLI 后重启工作台。</p>}
      <div className="segmented">
        <button className={mode === 'redraw' ? 'active' : ''} onClick={() => props.onMode('redraw')}>整帧重画</button>
        <button className={mode === 'repair' ? 'active' : ''} onClick={() => props.onMode('repair')}>局部修补</button>
      </div>
      <p className="muted hint">
        {mode === 'redraw'
          ? '参考前后帧和角色设定重画这一帧，生成后自动对齐到原来的脚底和重心。'
          : '只重画框里的部分，框外的像素保持原样。'}
      </p>
      {mode === 'repair' && (
        <div className="row">
          <button className={selecting ? 'active-outline' : ''} onClick={props.onToggleSelect}>
            {selecting ? '在画面上拖出区域…' : rect ? '重新框选' : '框选区域'}
          </button>
          {rect && <span className="muted">{rect[2] - rect[0]}×{rect[3] - rect[1]}px</span>}
          {rect && <button className="ghost" onClick={props.onClearRect}>清除</button>}
        </div>
      )}
      <textarea
        rows={3}
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder={mode === 'redraw'
          ? '想怎么改？比如：前面的手臂再抬高一点。留空则按前后帧自动理顺姿势'
          : '框里要怎么改？比如：把手画成握拳'}
      />
      {frame.note && !instruction && (
        <button className="ghost link" onClick={() => setInstruction(frame.note)}>用这帧的备注：{frame.note.slice(0, 24)}{frame.note.length > 24 ? '…' : ''}</button>
      )}
      <div className="row">
        <label className="inline">候选
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} 张</option>)}
          </select>
        </label>
        <button className="primary grow" disabled={busy || unavailable || (mode === 'repair' && !rect)} onClick={submit}>
          {busy ? '提交中…' : `生成 ${count} 张候选`}
        </button>
      </div>
      <p className="muted hint">每张约 1 分钟，会消耗你的 Codex 额度。生成时可以继续编辑其他帧。</p>

      <div className="jobs">
        {visible.map((job) => {
          const elapsed = (now / 1000) - job.createdAt;
          const errors = [...new Set(job.candidates.map((c) => c.error).filter((e): e is string => Boolean(e) && e !== '已取消'))];
          const previewing = preview?.jobId === job.id;
          return (
            <div key={job.id} className={`job ${job.status}`}>
              <div className="job-head">
                <span>{job.kind === 'repair' ? '局部修补' : '整帧重画'} · {STATUS[job.status]}{active(job) ? ` ${clock(elapsed)}` : ''}</span>
                <span className="muted">基于 v{job.sourceVersion}</span>
              </div>
              {job.instruction && <p className="job-text">{job.instruction}</p>}
              <div className="cands">
                {job.candidates.map((c) => {
                  const accepted = job.accepted.find((a) => a.index === c.index);
                  if (c.status === 'done') {
                    return (
                      <button
                        key={c.index}
                        className={`cand checker ${previewing && preview?.index === c.index ? 'active' : ''}`}
                        onClick={() => props.onPreview(job, c.index)}
                        title="点击在动画里预览"
                      >
                        <img src={props.candidateSrc(job, c.index)} alt={`候选 ${c.index}`} style={job.flipX ? { transform: 'scaleX(-1)' } : undefined} />
                        {accepted && <span className="tag">已采用 v{accepted.version}</span>}
                      </button>
                    );
                  }
                  return (
                    <div key={c.index} className={`cand placeholder ${c.status}`} title={c.error ?? ''}>
                      {c.status === 'running' ? <span className="spinner" /> : null}
                      <span>{STATUS[c.status]}</span>
                    </div>
                  );
                })}
              </div>
              {errors.length > 0 && <p className="error small">{errors.join('；')}</p>}
              <div className="row">
                {previewing && preview && (
                  <button className="primary" onClick={() => props.onAccept(job, preview.index)}>采用候选 {preview.index}</button>
                )}
                {active(job) && <button onClick={() => props.onCancel(job)}>取消</button>}
                {!active(job) && !job.reviewed && <button className="ghost" onClick={() => props.onReview(job, true)}>都不要</button>}
                {!active(job) && job.reviewed && <button className="ghost" onClick={() => props.onReview(job, false)}>重新打开</button>}
              </div>
            </div>
          );
        })}
        {hidden > 0 && (
          <button className="ghost link" onClick={() => setShowReviewed(true)}>显示已处理的 {hidden} 个任务</button>
        )}
        {showReviewed && hidden === 0 && jobs.some((j) => j.reviewed) && (
          <button className="ghost link" onClick={() => setShowReviewed(false)}>隐藏已处理的任务</button>
        )}
      </div>
    </section>
  );
}

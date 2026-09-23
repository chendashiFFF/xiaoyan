import { useEffect, useState } from 'react';
import type { Frame, FrameJobKind, Job, Rect } from '../types';

export interface PreviewRef {
  jobId: string;
  index: number;
}

interface Props {
  frame: Frame;
  /** e.g. "API · gpt-image-2.5-flare" */
  generatorLabel: string;
  /** Why generation cannot run right now, if it cannot. */
  generatorProblem: string | null;
  jobs: Job[];
  mode: FrameJobKind;
  onMode: (mode: FrameJobKind) => void;
  /** Label of the frame an in-between would go before, or null when there is none. */
  nextLabel: string | null;
  keepTotal: boolean;
  onKeepTotal: (keep: boolean) => void;
  /** Gaps that could still get an in-between (ones already being filled are left out). */
  gapCount: number;
  onSubmitAll: (candidates: number) => void;
  rect: Rect | null;
  selecting: boolean;
  onToggleSelect: () => void;
  onClearRect: () => void;
  onSubmit: (request: { kind: FrameJobKind; instruction: string; candidates: number }) => Promise<void>;
  preview: PreviewRef | null;
  onPreview: (job: Job, index: number) => void;
  onAccept: (job: Job, index: number) => void;
  onCancel: (job: Job) => void;
  onReview: (job: Job, reviewed: boolean) => void;
  candidateSrc: (job: Job, index: number) => string;
}

const STATUS: Record<Job['status'], string> = { queued: '排队中', running: '生成中', done: '已完成', failed: '失败', cancelled: '已取消' };
const KIND: Record<string, string> = { redraw: '整帧重画', repair: '局部修补', inbetween: '补中间帧' };
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
  const { frame, jobs, mode, rect, selecting, preview, nextLabel, generatorLabel, generatorProblem } = props;
  const [instruction, setInstruction] = useState('');
  const [count, setCount] = useState(2);
  const [busy, setBusy] = useState(false);
  const [showReviewed, setShowReviewed] = useState(false);
  const now = useNow(jobs.some(active));
  const visible = jobs.filter((job) => showReviewed || !job.reviewed || active(job));
  const hidden = jobs.length - visible.length;
  const unavailable = Boolean(generatorProblem);

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
      <h3>AI 重画 <small className="muted">{generatorLabel}</small></h3>
      {generatorProblem && <p className="error">{generatorProblem}</p>}
      <div className="segmented">
        <button className={mode === 'redraw' ? 'active' : ''} onClick={() => props.onMode('redraw')}>整帧重画</button>
        <button className={mode === 'repair' ? 'active' : ''} onClick={() => props.onMode('repair')}>局部修补</button>
        <button className={mode === 'inbetween' ? 'active' : ''} onClick={() => props.onMode('inbetween')}>补中间帧</button>
      </div>
      <p className="muted hint">
        {mode === 'redraw' && '参考前后帧和角色设定重画这一帧，生成后自动对齐到原来的脚底和重心。'}
        {mode === 'repair' && '只重画框里的部分，框外的像素保持原样。'}
        {mode === 'inbetween' && (nextLabel
          ? `在这一帧和${nextLabel}之间画一张过渡帧，采用后插在它们中间。`
          : '这是最后一帧，后面没有下一帧（改成"循环"播放后可以和第 1 帧之间补）。')}
      </p>
      {mode === 'inbetween' && (
        <label className="check">
          <input type="checkbox" checked={props.keepTotal} onChange={(e) => props.onKeepTotal(e.target.checked)} />
          <span>保持总时长（把这一帧的时长分一半给新帧）</span>
        </label>
      )}
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
        placeholder={{
          redraw: '想怎么改？比如：前面的手臂再抬高一点。留空则按前后帧自动理顺姿势',
          repair: '框里要怎么改？比如：把手画成握拳',
          inbetween: '一般留空即可；也可以补充，比如：裙摆飘得更明显',
        }[mode]}
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
        <button className="primary grow" disabled={busy || unavailable || (mode === 'repair' && !rect) || (mode === 'inbetween' && !nextLabel)} onClick={submit}>
          {busy ? '提交中…' : `生成 ${count} 张候选`}
        </button>
      </div>
      {mode === 'inbetween' && (
        <button
          className="batch"
          disabled={busy || unavailable || !props.gapCount}
          onClick={() => props.onSubmitAll(count)}
          title="每两帧之间都补一帧（已经在补的间隔会跳过）"
        >
          {props.gapCount ? `所有间隔各补一帧（${props.gapCount} 处 × ${count} 张）` : '所有间隔都已经在补了'}
        </button>
      )}
      <p className="muted hint">每张约 1 分钟，会消耗你的 生图额度。生成时可以继续编辑其他帧。</p>

      <div className="jobs">
        {visible.map((job) => {
          const elapsed = (now / 1000) - job.createdAt;
          const errors = [...new Set(job.candidates.map((c) => c.error).filter((e): e is string => Boolean(e) && e !== '已取消'))];
          const previewing = preview?.jobId === job.id;
          return (
            <div key={job.id} className={`job ${job.status}`}>
              <div className="job-head">
                <span>{KIND[job.kind]} · {STATUS[job.status]}{active(job) ? ` ${clock(elapsed)}` : ''}</span>
                {job.kind !== 'inbetween' && <span className="muted">基于 v{job.sourceVersion}</span>}
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
                        <img src={props.candidateSrc(job, c.index)} alt={`候选 ${c.index}`} style={job.flipX && job.kind !== 'inbetween' ? { transform: 'scaleX(-1)' } : undefined} />
                        {accepted && <span className="tag">{accepted.version ? `已采用 v${accepted.version}` : '已插入'}</span>}
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

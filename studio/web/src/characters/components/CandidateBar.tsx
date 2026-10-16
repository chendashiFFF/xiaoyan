import type { Job } from '../types';

interface Props {
  job: Job;
  index: number;
  title: string;
  /** Other jobs in this action whose finished candidates still wait for a decision. */
  waiting: number;
  candidateSrc: (job: Job, index: number) => string;
  onPick: (index: number) => void;
  onAccept: () => void;
  onDismiss: () => void;
  onNext: () => void;
  onExit: () => void;
}

/** Sits on top of the canvas while a candidate is previewed: switch, accept or reject without leaving the frame. */
export function CandidateBar({ job, index, title, waiting, candidateSrc, onPick, onAccept, onDismiss, onNext, onExit }: Props) {
  const flip = job.flipX && job.kind !== 'inbetween' ? { transform: 'scaleX(-1)' } : undefined;
  return (
    <div className="candidate-bar">
      <div className="cb-title">
        <strong>{title}</strong>
        <span className="muted">按空格播放 · 数字键切换 · 回车{job.kind === 'inbetween' ? '插入' : '采用'}</span>
      </div>
      <div className="cb-cands">
        {job.candidates.map((c) => (c.status === 'done' ? (
          <button
            key={c.index}
            className={`cb-cand checker ${c.index === index ? 'active' : ''}`}
            onClick={() => onPick(c.index)}
            title={`候选 ${c.index}（按 ${c.index}）`}
          >
            <img src={candidateSrc(job, c.index)} alt="" style={flip} />
            <span>{c.index}</span>
          </button>
        ) : (
          <div key={c.index} className={`cb-cand pending ${c.status}`} title={c.error ?? ''}>
            {c.status === 'running' || c.status === 'queued' ? <i className="spinner" /> : <span>✕</span>}
          </div>
        )))}
      </div>
      <div className="cb-actions">
        <button className="primary" onClick={onAccept}>{job.kind === 'inbetween' ? '插入这张' : '采用这张'} ↵</button>
        <button onClick={onDismiss} title="这组候选都不要，标记为已处理">都不要</button>
        {waiting > 0 && <button onClick={onNext} title="先跳过，去看下一组">下一组（还有 {waiting}）→</button>}
        <button className="ghost" onClick={onExit} title="Esc">退出</button>
      </div>
    </div>
  );
}

import { Fragment, useState } from 'react';
import type { ActionQc } from '../qc';
import type { Action, Frame } from '../types';

interface Props {
  action: Action;
  current: number;
  qc: ActionQc;
  urlOf: (frame: Frame) => string;
  onSelect: (index: number) => void;
  onMove: (from: number, to: number) => void;
  /** Per frame id: an AI job is still running, or finished candidates are waiting for review. */
  aiState?: Record<string, 'running' | 'ready' | undefined>;
}

const PX_PER_MS = 0.9;

export function Timeline({ action, current, qc, urlOf, onSelect, onMove, aiState = {} }: Props) {
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const cell = action.cellSize;
  const n = action.frames.length;

  const dropIndex = (event: React.DragEvent<HTMLDivElement>, index: number) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? index : index + 1;
  };

  return (
    <div className="timeline" onDragEnd={() => setDrag(null)}>
      {action.frames.map((frame, index) => {
        const flags = qc.frames[index]?.flags ?? [];
        const warn = flags.filter((f) => f.level === 'warn').length;
        const info = flags.length - warn;
        const change = qc.changes[index];
        const jumpNext = qc.frames[(index + 1) % n]?.flags.some((f) => f.kind === 'jump') && change !== null;
        const dup = flags.some((f) => f.kind === 'dup');
        const ratio = change !== null && qc.medianChange ? change / qc.medianChange : 0;
        const width = Math.max(64, Math.min(280, frame.duration * PX_PER_MS));
        return (
          <Fragment key={frame.id}>
            {drag && drag.to === index && drag.from !== index && drag.from !== index - 1 && <div className="drop-marker" />}
            <div
              className={`tl-frame ${index === current ? 'active' : ''} ${drag?.from === index ? 'dragging' : ''}`}
              style={{ width }}
              draggable
              onClick={() => onSelect(index)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(index));
                setDrag({ from: index, to: index });
              }}
              onDragOver={(event) => {
                if (!drag) return;
                event.preventDefault();
                const to = dropIndex(event, index);
                if (to !== drag.to) setDrag({ ...drag, to });
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (drag) {
                  const to = dropIndex(event, index);
                  const target = to > drag.from ? to - 1 : to;
                  if (target !== drag.from) onMove(drag.from, target);
                }
                setDrag(null);
              }}
              title={flags.map((f) => f.message).join('\n') || '未发现问题'}
            >
              <div className="tl-thumb checker">
                <img
                  src={urlOf(frame)}
                  alt=""
                  draggable={false}
                  style={{ transform: `translate(${(frame.offset[0] / cell) * 100}%, ${(frame.offset[1] / cell) * 100}%)${frame.flipX ? ' scaleX(-1)' : ''}` }}
                />
                <span className="tl-corner">
                  {aiState[frame.id] === 'running' && <span className="badge ai running" title="AI 正在生成候选">AI…</span>}
                  {aiState[frame.id] === 'ready' && <span className="badge ai" title="有新的 AI 候选等你看">新</span>}
                  {frame.flipX && <span className="badge ver" title="已水平翻转">⇋</span>}
                  {frame.versions.length > 1 && <span className="badge ver" title="当前使用的版本">v{frame.version}</span>}
                </span>
              </div>
              <div className="tl-meta">
                <span className="tl-index">{index + 1}</span>
                <span className="tl-duration">{frame.duration}ms</span>
                {warn > 0 && <span className="badge warn">⚠ {warn}</span>}
                {warn === 0 && info > 0 && <span className="badge info">i</span>}
              </div>
            </div>
            {change !== null && (
              <div
                className={`tl-change ${jumpNext ? 'jump' : dup ? 'dup' : ''}`}
                title={`到${index + 1 === n ? '第 1' : `第 ${index + 2}`} 帧的变化量 ${change.toFixed(1)}（平均 ${qc.medianChange.toFixed(1)}）`}
              >
                <i style={{ height: `${Math.max(6, Math.min(100, ratio * 40))}%` }} />
                {index + 1 === n && <span className="wrap">↺</span>}
              </div>
            )}
          </Fragment>
        );
      })}
      {drag && drag.to === n && drag.from !== n - 1 && <div className="drop-marker" />}
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ActionQc } from '../qc';
import type { Action, Frame, Playback } from '../types';

export interface AlignAxes {
  x: boolean;
  y: boolean;
}

interface Props {
  action: Action;
  index: number;
  qc: ActionQc;
  versionUrl: (frame: Frame, version: number) => string;
  onUpdateAction: (patch: Partial<Pick<Action, 'label' | 'grounded' | 'playback'>>, coalesce?: string) => void;
  onUpdateFrame: (index: number, patch: Partial<Frame>, coalesce?: string) => void;
  onSetAllDurations: (duration: number) => void;
  onAlign: (indices: number[], axes: AlignAxes) => void;
  onReplace: (index: number, file: File) => Promise<void>;
  aiPanel?: ReactNode;
  onDeleteAction: () => void;
}

const clampDuration = (value: number) => Math.max(10, Math.min(10000, Math.round(value) || 10));

/** Number input that only commits parseable, in-range values, so typing "150" is not clamped at "1". */
function NumberField({ value, onCommit, min = -Infinity, max = Infinity, step = 1 }: {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current || Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      type="number"
      className="num"
      value={text}
      step={step}
      min={Number.isFinite(min) ? min : undefined}
      max={Number.isFinite(max) ? max : undefined}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; setText(String(value)); }}
      onChange={(e) => {
        setText(e.target.value);
        const parsed = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max) onCommit(Math.round(parsed));
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

export function Inspector({ action, index, qc, versionUrl, onUpdateAction, onUpdateFrame, onSetAllDurations, onAlign, onReplace, aiPanel, onDeleteAction }: Props) {
  const frame = action.frames[index];
  const frameQc = qc.frames[index];
  const [bulkDuration, setBulkDuration] = useState(100);
  const [axes, setAxes] = useState<AlignAxes>({ x: true, y: true });
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const total = action.frames.reduce((sum, f) => sum + f.duration, 0);
  const averageFps = total ? (action.frames.length * 1000) / total : 0;

  return (
    <aside className="inspector">
      <section>
        <h3>动作</h3>
        <label className="field">
          <span>名称</span>
          <input value={action.label} onChange={(e) => onUpdateAction({ label: e.target.value }, 'label')} />
        </label>
        <label className="field">
          <span>播放方式</span>
          <select value={action.playback} onChange={(e) => onUpdateAction({ playback: e.target.value as Playback })}>
            <option value="loop">循环（1→N→1）</option>
            <option value="pingpong">往返（1→N→1 倒放回来）</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={action.grounded} onChange={(e) => onUpdateAction({ grounded: e.target.checked })} />
          <span>脚踩地面（检查脚底和重心）</span>
        </label>
        <p className="muted">
          {action.frames.length} 帧 · 共 {total}ms · 平均 {averageFps.toFixed(1)} fps
        </p>
        <div className="row">
          <span>所有帧时长设为</span>
          <NumberField value={bulkDuration} min={10} max={10000} step={10} onCommit={setBulkDuration} />
          <span>ms</span>
          <button onClick={() => onSetAllDurations(clampDuration(bulkDuration))}>应用</button>
        </div>
        <div className="row">
          <label className="check"><input type="checkbox" checked={axes.x} onChange={(e) => setAxes({ ...axes, x: e.target.checked })} /><span>重心</span></label>
          <label className="check"><input type="checkbox" checked={axes.y} onChange={(e) => setAxes({ ...axes, y: e.target.checked })} /><span>脚底</span></label>
          <button disabled={!axes.x && !axes.y} onClick={() => onAlign(action.frames.map((_, i) => i), axes)}>对齐全部帧</button>
        </div>
        <button className="ghost danger" onClick={onDeleteAction}>删除这个动作…</button>
      </section>

      {frame && (
        <section>
          <h3>第 {index + 1} 帧 <small className="muted">{frame.id}</small></h3>
          <div className="field">
            <span>时长</span>
            <div className="row">
              <button onClick={() => onUpdateFrame(index, { duration: clampDuration(frame.duration - 10) }, `dur-${frame.id}`)}>−</button>
              <NumberField value={frame.duration} min={10} max={10000} step={10} onCommit={(duration) => onUpdateFrame(index, { duration }, `dur-${frame.id}`)} />
              <button onClick={() => onUpdateFrame(index, { duration: clampDuration(frame.duration + 10) }, `dur-${frame.id}`)}>+</button>
              <span className="muted">ms</span>
            </div>
          </div>
          <div className="field">
            <span>位置偏移</span>
            <div className="row">
              <label className="inline">X <NumberField value={frame.offset[0]} min={-action.cellSize} max={action.cellSize} onCommit={(x) => onUpdateFrame(index, { offset: [x, frame.offset[1]] }, `off-${frame.id}`)} /></label>
              <label className="inline">Y <NumberField value={frame.offset[1]} min={-action.cellSize} max={action.cellSize} onCommit={(y) => onUpdateFrame(index, { offset: [frame.offset[0], y] }, `off-${frame.id}`)} /></label>
              <button disabled={!frame.offset[0] && !frame.offset[1]} onClick={() => onUpdateFrame(index, { offset: [0, 0] })}>归零</button>
            </div>
            <label className="check">
              <input type="checkbox" checked={Boolean(frame.flipX)} onChange={(e) => onUpdateFrame(index, { flipX: e.target.checked })} />
              <span>水平翻转（H）</span>
            </label>
            <div className="row">
              <button disabled={!axes.x && !axes.y} onClick={() => onAlign([index], axes)}>自动对齐这一帧</button>
            </div>
          </div>

          <div className="field">
            <span>检查结果</span>
            {!frameQc?.loaded && <p className="muted">加载中…</p>}
            {frameQc?.loaded && frameQc.flags.length === 0 && <p className="ok">未发现问题</p>}
            <ul className="flags">
              {frameQc?.flags.map((flag) => (
                <li key={flag.kind} className={flag.level}>{flag.message}</li>
              ))}
            </ul>
          </div>

          <div className="field">
            <span>版本</span>
            <div className="versions">
              {frame.versions.map((version) => (
                <button
                  key={version}
                  className={`version checker ${version === frame.version ? 'active' : ''}`}
                  onClick={() => onUpdateFrame(index, { version })}
                  title={`v${version}`}
                >
                  <img src={versionUrl(frame, version)} alt={`v${version}`} style={frame.flipX ? { transform: 'scaleX(-1)' } : undefined} />
                  <span>v{version}</span>
                </button>
              ))}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/webp,image/jpeg"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                setUploading(true);
                try {
                  await onReplace(index, file);
                } finally {
                  setUploading(false);
                }
              }}
            />
            <button disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? '上传中…' : '上传图片作为新版本'}
            </button>
          </div>

          <label className="field">
            <span>备注</span>
            <textarea rows={3} value={frame.note} placeholder="比如：左手应该再抬高一点" onChange={(e) => onUpdateFrame(index, { note: e.target.value }, `note-${frame.id}`)} />
          </label>
        </section>
      )}

      {aiPanel}

      <section className="shortcuts">
        <h3>快捷键</h3>
        <dl>
          <dt>空格</dt><dd>播放 / 暂停</dd>
          <dt>← →</dt><dd>上一帧 / 下一帧</dd>
          <dt>⌥ + 方向键</dt><dd>移动当前帧 1px（加 ⇧ 为 5px）</dd>
          <dt>拖动画面</dt><dd>移动当前帧</dd>
          <dt>[ ]</dt><dd>当前帧时长 −10 / +10ms</dd>
          <dt>H</dt><dd>水平翻转当前帧</dd>
          <dt>O</dt><dd>开关洋葱皮</dd>
          <dt>⌘D</dt><dd>复制当前帧</dd>
          <dt>Delete</dt><dd>删除当前帧</dd>
          <dt>⌘Z / ⇧⌘Z</dt><dd>撤销 / 重做</dd>
          <dt>Esc</dt><dd>退出候选预览 / 框选</dd>
        </dl>
      </section>
    </aside>
  );
}

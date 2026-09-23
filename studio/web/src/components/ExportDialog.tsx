import { useState } from 'react';
import type { ExportFormat, ExportOptions, ExportResult } from '../types';

interface Props {
  actionLabel: string;
  onClose: () => void;
  onExport: (options: ExportOptions) => Promise<ExportResult>;
}

const STORAGE_KEY = 'studio-export-options';
const DEFAULTS: ExportOptions = {
  format: 'gif',
  scale: 2,
  background: 'transparent',
  matte: '#ffffff',
  alphaThreshold: 128,
  trim: true,
  padding: 8,
};

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'gif', label: 'GIF', hint: '到处都能播放；透明只有"全透明/不透明"两种，边缘会压到一个底色上' },
  { id: 'webp', label: 'WebP', hint: '完整半透明、体积小，浏览器和大多数聊天软件支持' },
  { id: 'apng', label: 'APNG', hint: '完整半透明的动图 PNG，浏览器支持' },
  { id: 'sheet', label: '精灵图 + JSON', hint: '所有帧拼成一张 PNG，附带每帧时长，给游戏或桌面宠物用' },
];

function loadDefaults(): ExportOptions {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
  } catch {
    return DEFAULTS;
  }
}

export function ExportDialog({ actionLabel, onClose, onExport }: Props) {
  const [options, setOptions] = useState<ExportOptions>(loadDefaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ExportResult[]>([]);
  const set = (patch: Partial<ExportOptions>) => setOptions((prev) => ({ ...prev, ...patch }));
  const transparent = options.background === 'transparent';

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(options)); } catch { /* storage may be unavailable */ }
      const result = await onExport(options);
      setResults((prev) => [result, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="导出">
        <header>
          <h2>导出「{actionLabel}」</h2>
          <button className="ghost" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <div className="modal-body">
          <div className="export-form">
            <div className="field">
              <span>格式</span>
              <div className="segmented">
                {FORMATS.map((f) => (
                  <button key={f.id} className={options.format === f.id ? 'active' : ''} onClick={() => set({ format: f.id })}>{f.label}</button>
                ))}
              </div>
              <p className="muted">{FORMATS.find((f) => f.id === options.format)?.hint}</p>
            </div>
            <label className="field">
              <span>放大倍数</span>
              <select value={options.scale} onChange={(e) => set({ scale: Number(e.target.value) })}>
                {[1, 2, 3, 4, 6, 8].map((s) => <option key={s} value={s}>{s}×</option>)}
              </select>
            </label>
            <div className="field">
              <span>背景</span>
              <div className="row">
                <label className="check"><input type="radio" checked={transparent} onChange={() => set({ background: 'transparent' })} /><span>透明</span></label>
                <label className="check"><input type="radio" checked={!transparent} onChange={() => set({ background: transparent ? '#ffffff' : options.background })} /><span>纯色</span></label>
                {!transparent && <input type="color" value={options.background} onChange={(e) => set({ background: e.target.value })} />}
              </div>
            </div>
            {options.format === 'gif' && transparent && (
              <div className="field">
                <span>GIF 边缘底色</span>
                <div className="row">
                  <input type="color" value={options.matte} onChange={(e) => set({ matte: e.target.value })} />
                  <span className="muted">选成 GIF 将来要放上去的背景色，边缘就不会有白边或黑边</span>
                </div>
                <label className="row">
                  <span>不透明阈值</span>
                  <input type="range" min={32} max={224} step={8} value={options.alphaThreshold} onChange={(e) => set({ alphaThreshold: Number(e.target.value) })} />
                  <span className="muted">{options.alphaThreshold}</span>
                </label>
              </div>
            )}
            <label className="check">
              <input type="checkbox" checked={options.trim} onChange={(e) => set({ trim: e.target.checked })} />
              <span>裁掉四周空白（保留 {options.padding}px 边距）</span>
            </label>
            {error && <p className="error">{error}</p>}
            <button className="primary" disabled={busy} onClick={run}>{busy ? '导出中…' : '导出'}</button>
          </div>
          <div className="export-results">
            {!results.length && <p className="muted">导出的文件会保存在项目的 exports 目录里，也会显示在这里。</p>}
            {results.map((r) => (
              <figure key={r.url}>
                <div className="checker export-preview"><img src={r.url} alt="" /></div>
                <figcaption>
                  <a href={r.url} download>下载</a>
                  <span className="muted">{r.width}×{r.height} · {r.frames} 帧 · {r.totalDuration}ms · {(r.bytes / 1024).toFixed(0)}KB</span>
                  <code>{r.file}</code>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

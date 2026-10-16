import { useEffect, useRef, useState } from 'react';
import type { ExportFormat, ExportOptions, ExportResult } from '../types';

interface Props {
  actionLabel: string;
  onPreview: (options: ExportOptions) => Promise<{ original: string; preview: string; width: number; height: number }>;
  onClose: () => void;
  onExport: (options: ExportOptions) => Promise<ExportResult>;
}

const STORAGE_KEY = 'studio-export-options';
const STYLE_VERSION = 3;
const DEFAULTS: ExportOptions = {
  format: 'gif',
  scale: 1,
  pixelStep: 1,
  patina: 'none',
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
  { id: 'sheet', label: '精灵图 + JSON', hint: '所有帧拼成一张 PNG，附带每帧时长，给游戏或视频制作用' },
];

function loadDefaults(): ExportOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULTS, format: FORMATS.some(f => f.id === saved.format) ? saved.format : DEFAULTS.format };
  } catch {
    return DEFAULTS;
  }
}

export function ExportDialog({ actionLabel, onClose, onExport, onPreview }: Props) {
  const [options, setOptions] = useState<ExportOptions>(loadDefaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ExportResult[]>([]);
  const set = (patch: Partial<ExportOptions>) => setOptions((prev) => ({ ...prev, ...patch }));
  const [preview, setPreview] = useState<Awaited<ReturnType<Props['onPreview']>> | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewBusy, setPreviewBusy] = useState(true);
  const previewFn = useRef(onPreview);
  previewFn.current = onPreview;
  useEffect(() => {
    let cancelled = false;
    setPreviewBusy(true); setPreviewError('');
    const timer = window.setTimeout(() => {
      void previewFn.current(options).then(value => { if (!cancelled) setPreview(value); })
        .catch(err => { if (!cancelled) setPreviewError(String(err)); })
        .finally(() => { if (!cancelled) setPreviewBusy(false); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [options]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...options, styleVersion: STYLE_VERSION })); } catch { /* storage may be unavailable */ }
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
            <p className="muted">自动裁掉四周透明空白，保留 8px 边距。所有帧统一裁剪，不改变人物大小、颜色和动作时长。</p>
            {error && <p className="error">{error}</p>}
            <button className="primary" disabled={busy} onClick={run}>{busy ? '导出中…' : '导出'}</button>
          </div>
          <div className="export-results">
            <p className="muted">首帧效果预览 · {previewBusy ? '更新中…' : preview ? `${preview.width}×${preview.height}px` : ''}</p>
            {previewError && <p className="error">{previewError}</p>}
            {preview && !previewBusy && !previewError && <div className="export-compare">
              <figure><figcaption>导出效果</figcaption><div className="checker export-preview"><img src={preview.preview} alt="导出效果" /></div></figure>
            </div>}

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

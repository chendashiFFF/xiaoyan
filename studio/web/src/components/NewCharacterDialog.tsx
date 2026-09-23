import { useEffect, useMemo, useRef, useState } from 'react';

import type { ProjectSummary } from '../types';

export interface NewCharacterRequest {
  id: string;
  name: string;
  identity: File | null;
  design: File | null;
  /** AI mode: loose source images to draw a clean master reference from */
  sources: File[];
  notes: string;
  style: string;
}

interface Props {
  existingIds: string[];
  projects: ProjectSummary[];
  onClose: () => void;
  onCreate: (request: NewCharacterRequest) => Promise<void>;
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SOURCES = 6;
const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

/** Growable list of reference images: add in several goes (picker, drag-and-drop or paste), remove any one. */
function ImageList({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const urls = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(() => () => urls.forEach((url) => URL.revokeObjectURL(url)), [urls]);

  const add = (incoming: File[]) => {
    const images = incoming.filter((f) => f.type.startsWith('image/'));
    const fresh = images.filter((f) => !files.some((existing) => sameFile(existing, f)));
    const room = MAX_SOURCES - files.length;
    const skipped = fresh.length - Math.max(0, room);
    setNote(skipped > 0 ? `最多 ${MAX_SOURCES} 张，有 ${skipped} 张没加进来` : images.length < incoming.length ? '只能添加图片文件' : null);
    if (room > 0 && fresh.length) onChange([...files, ...fresh.slice(0, room)]);
  };

  return (
    <div
      className={`image-list ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); add([...e.dataTransfer.files]); }}
      onPaste={(e) => {
        const pasted = [...e.clipboardData.files];
        if (pasted.length) { e.preventDefault(); add(pasted); }
      }}
      tabIndex={0}
    >
      {files.map((file, i) => (
        <div key={`${file.name}-${file.lastModified}-${i}`} className="image-item checker" title={file.name}>
          <img src={urls[i]} alt="" />
          <button className="remove" onClick={() => onChange(files.filter((_, j) => j !== i))} title="移除这张" aria-label="移除">✕</button>
          <span className="name">{file.name}</span>
        </div>
      ))}
      {files.length < MAX_SOURCES && (
        <button className="image-item add" onClick={() => inputRef.current?.click()}>
          <span>＋</span>
          <small>添加图片</small>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/webp,image/jpeg"
        multiple
        hidden
        onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ''; }}
      />
      <p className="muted hint list-hint">
        {files.length}/{MAX_SOURCES} 张 · 可以分几次添加，也可以直接把图片拖进来或 ⌘V 粘贴
        {note && <span className="warn-text"> · {note}</span>}
      </p>
    </div>
  );
}

function usePreview(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return undefined;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

export function NewCharacterDialog({ existingIds, projects, onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [identity, setIdentity] = useState<File | null>(null);
  const [design, setDesign] = useState<File | null>(null);
  const [mode, setMode] = useState<'upload' | 'ai'>('upload');
  const [sources, setSources] = useState<File[]>([]);
  const [notes, setNotes] = useState('');
  const [style, setStyle] = useState('pixel');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const identityUrl = usePreview(identity);
  const designUrl = usePreview(design);
  const idError = !id ? '填一个英文 ID' : !SLUG.test(id) ? '只能用小写字母、数字、- 和 _' : existingIds.includes(id) ? '这个 ID 已经有了' : null;

  const ready = !idError && (mode === 'upload' ? Boolean(identity) : sources.length > 0);
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(mode === 'upload'
        ? { id, name: name.trim() || id, identity, design, sources: [], notes: '', style: 'pixel' }
        : { id, name: name.trim() || id, identity: null, design: null, sources, notes, style });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const picker = (label: string, hint: string, url: string | null, onPick: (file: File | null) => void) => (
    <label className="ref-pick">
      <span>{label}</span>
      <span className="ref-preview small checker">{url ? <img src={url} alt="" /> : <span className="muted">点击选择图片</span>}</span>
      <small className="muted">{hint}</small>
      <input type="file" accept="image/png,image/webp,image/jpeg" hidden onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
    </label>
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="新人物">
        <header>
          <h2>新人物</h2>
          <button className="ghost" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <div className="modal-form">
          <div className="grid-2">
            <label className="field">
              <span>名字</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="小燕" autoFocus />
            </label>
            <label className="field">
              <span>ID（文件夹名）</span>
              <input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="xiaoyan2" />
              {id && idError && <small className="error">{idError}</small>}
            </label>
          </div>
          <div className="segmented">
            <button className={mode === 'upload' ? 'active' : ''} onClick={() => setMode('upload')}>我有规范的正面全身图</button>
            <button className={mode === 'ai' ? 'active' : ''} onClick={() => setMode('ai')}>只有几张参考图，让 AI 画规范图</button>
          </div>
          {mode === 'upload' ? (
            <div className="grid-2">
              {picker('主参考图（必填）', '正面、站直、全身，透明背景或纯品红底', identityUrl, setIdentity)}
              {picker('设定图（可选）', '三视图、细节特写都可以', designUrl, setDesign)}
            </div>
          ) : (
            <>
              <div className="field">
                <span>参考图（1–6 张，不同角度、姿势、画风都行）</span>
                <ImageList files={sources} onChange={setSources} />
              </div>
              <label className="field">
                <span>补充说明（可选）</span>
                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="比如：发饰在左边、眼睛是金色" />
              </label>
              <label className="field">
                <span>画风</span>
                <select value={style} onChange={(e) => setStyle(e.target.value)}>
                  <option value="pixel">像素风 HD-2D</option>
                  <option value="source">保持参考图的画风</option>
                  {projects.filter((p) => p.thumb).map((p) => <option key={p.id} value={`from:${p.id}`}>和「{p.name}」同一画风</option>)}
                </select>
              </label>
              <p className="muted hint">创建后 AI 会画 2 张正面全身主参考图（约 1–2 分钟，消耗生图额度），在"角色参考"里挑一张，还可以接着生成三视图。</p>
            </>
          )}
          {error && <p className="error">{error}</p>}
          <div className="row end">
            <button onClick={onClose}>取消</button>
            <button className="primary" disabled={busy || !ready} onClick={submit}>{busy ? '创建中…' : mode === 'ai' ? '创建并生成主参考图' : '创建人物'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

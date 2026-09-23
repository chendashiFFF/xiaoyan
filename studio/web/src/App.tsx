import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, candidateUrl, frameUrl } from './api';
import { ActionList } from './components/ActionList';
import { AiPanel } from './components/AiPanel';
import { ExportDialog } from './components/ExportDialog';
import { Inspector, type AlignAxes } from './components/Inspector';
import { Timeline } from './components/Timeline';
import { Viewer, type ViewSettings } from './components/Viewer';
import { historyReducer, initialHistory } from './history';
import { loadImage, useImages } from './images';
import { alignedOffset, computeQc } from './qc';
import type { Action, CodexStatus, ExportOptions, Frame, Job, JobKind, Playback, Project, Rect } from './types';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

const VIEW_KEY = 'studio-view';
const DEFAULT_VIEW: ViewSettings = { zoom: 'fit', background: 'checker', onionPrev: 1, onionNext: 0, onionOpacity: 0.35, guides: true };
const BACKGROUNDS = [
  { value: 'checker', label: '棋盘格' },
  { value: '#ffffff', label: '白' },
  { value: '#1b1c21', label: '黑' },
  { value: '#8a8f99', label: '灰' },
  { value: '#ff00ff', label: '品红' },
];
const SAVE_LABELS: Record<SaveState, string> = { saved: '已保存', dirty: '未保存', saving: '保存中…', error: '保存失败' };

function loadView(): ViewSettings {
  try {
    return { ...DEFAULT_VIEW, ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') };
  } catch {
    return DEFAULT_VIEW;
  }
}

function parseHash(): { pid?: string; aid?: string } {
  const [pid, aid] = window.location.hash.replace(/^#\/?/, '').split('/');
  return { pid, aid };
}

function advance(index: number, direction: number, n: number, playback: Playback): [number, number] {
  if (n < 2) return [0, 1];
  if (playback === 'loop') return [(index + 1) % n, 1];
  const next = index + direction;
  if (next >= n) return [n - 2, -1];
  if (next < 0) return [1, 1];
  return [next, direction];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const jobActive = (job: Job) => job.status === 'queued' || job.status === 'running';

interface Preview {
  jobId: string;
  index: number;
  frameId: string;
  url: string;
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [actions, setActions] = useState<Record<string, Action>>({});
  const [actionId, setActionId] = useState<string | null>(null);
  const [history, dispatch] = useReducer(historyReducer, initialHistory);
  const doc = history.doc;
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [view, setView] = useState<ViewSettings>(loadView);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [aiMode, setAiMode] = useState<JobKind>('redraw');
  const [repairRect, setRepairRect] = useState<Rect | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const pid = project?.id ?? '';

  // ---- loading -------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const projects = await api.listProjects();
        if (!projects.length) {
          setLoadError('还没有项目。先在仓库根目录运行 npm run studio:import 导入现有动作。');
          return;
        }
        const hash = parseHash();
        const loaded = await api.getProject(projects.find((p) => p.id === hash.pid)?.id ?? projects[0].id);
        const docs = await Promise.all(loaded.actions.map((a) => api.getAction(loaded.id, a.id)));
        setProject(loaded);
        setActions(Object.fromEntries(docs.map((d) => [d.id, d])));
        setActionId(loaded.actions.find((a) => a.id === hash.aid)?.id ?? loaded.actions[0]?.id ?? null);
      } catch (error) {
        setLoadError(`加载失败：${message(error)}。后端是否已启动（npm run studio）？`);
      }
    })();
    api.codexStatus().then(setCodexStatus, () => setCodexStatus({ available: false, version: null, model: '?' }));
  }, []);

  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    if (!actionId || !pid) return;
    const next = actionsRef.current[actionId];
    if (!next) return;
    dispatch({ type: 'load', doc: next });
    setCurrent(0);
    setPlaying(false);
    setPreview(null);
    setRepairRect(null);
    setSelecting(false);
    setJobs([]);
    window.history.replaceState(null, '', `#/${pid}/${actionId}`);
  }, [actionId, pid]);

  // Keep the per-action cache in sync so the sidebar and action switching see unsaved edits too.
  useEffect(() => {
    if (doc && history.revision > 0) setActions((prev) => ({ ...prev, [doc.id]: doc }));
  }, [doc, history.revision]);

  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* storage may be unavailable */ }
  }, [view]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // ---- autosave ------------------------------------------------------------
  const pendingDoc = useRef<Action | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const saveChain = useRef<Promise<void>>(Promise.resolve());

  const flushSave = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    const toSave = pendingDoc.current;
    pendingDoc.current = null;
    if (toSave) {
      saveChain.current = saveChain.current.then(async () => {
        setSaveState('saving');
        try {
          await api.saveAction(pid, toSave);
          if (!pendingDoc.current) setSaveState('saved');
        } catch (error) {
          setSaveState('error');
          setNotice(`保存失败：${message(error)}`);
        }
      });
    }
    await saveChain.current;
  }, [pid]);

  useEffect(() => {
    if (!doc || history.revision === 0) return;
    pendingDoc.current = doc;
    setSaveState('dirty');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void flushSave(); }, 500);
  }, [doc, history.revision, flushSave]);

  useEffect(() => {
    const onUnload = () => {
      const toSave = pendingDoc.current;
      if (!toSave || !pid) return;
      void fetch(`/api/projects/${pid}/actions/${toSave.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toSave),
        keepalive: true,
      });
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [pid]);

  const selectAction = useCallback(async (id: string) => {
    await flushSave();
    setActionId(id);
  }, [flushSave]);

  // ---- images & checks -----------------------------------------------------
  const docId = doc?.id ?? '';
  const urlOf = useCallback(
    (frame: Frame) => (preview && preview.frameId === frame.id ? preview.url : frameUrl(pid, docId, frame.id, frame.version)),
    [pid, docId, preview],
  );
  const allUrls = useMemo(() => {
    const urls = new Set<string>();
    doc?.frames.forEach((f) => urls.add(urlOf(f)));
    Object.values(actions).forEach((a) => a.frames.forEach((f) => urls.add(frameUrl(pid, a.id, f.id, f.version))));
    return [...urls];
  }, [actions, doc, urlOf, pid]);
  const images = useImages(allUrls);
  const loadedCount = images.size;

  const qc = useMemo(
    () => (doc ? computeQc(doc, images, urlOf) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, loadedCount, urlOf],
  );
  const warnings = useMemo(() => {
    const result: Record<string, number | undefined> = {};
    for (const action of Object.values(actions)) {
      const source = action.id === doc?.id ? doc : action;
      const url = (f: Frame) => frameUrl(pid, source.id, f.id, f.version);
      result[action.id] = source.frames.every((f) => images.has(url(f))) ? computeQc(source, images, url).warnCount : undefined;
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, doc, loadedCount, pid]);

  const summaries = useMemo(() => (project?.actions ?? []).map((summary) => {
    const action = actions[summary.id];
    if (!action) return summary;
    const first = action.frames[0];
    return {
      ...summary,
      label: action.label,
      frameCount: action.frames.length,
      thumb: first ? frameUrl(pid, action.id, first.id, first.version) : null,
    };
  }), [project, actions, pid]);

  // ---- playback ------------------------------------------------------------
  const frameCount = doc?.frames.length ?? 0;
  useEffect(() => {
    if (current >= frameCount && frameCount) setCurrent(frameCount - 1);
  }, [current, frameCount]);

  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    if (!playing || !doc || !doc.frames.length) return undefined;
    let raf = 0;
    let last = performance.now();
    let elapsed = 0;
    let direction = 1;
    let index = Math.min(currentRef.current, doc.frames.length - 1);
    const tick = (now: number) => {
      elapsed += (now - last) * speed;
      last = now;
      let guard = 0;
      while (elapsed >= doc.frames[index].duration && guard < 100) {
        elapsed -= doc.frames[index].duration;
        [index, direction] = advance(index, direction, doc.frames.length, doc.playback);
        guard += 1;
      }
      setCurrent(index);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, doc, speed]);

  const step = useCallback((delta: number) => {
    setPlaying(false);
    if (frameCount) setCurrent((i) => (i + delta + frameCount) % frameCount);
  }, [frameCount]);

  // ---- edits ---------------------------------------------------------------
  const edit = useCallback((update: (d: Action) => Action, coalesce?: string) => {
    dispatch({ type: 'edit', update, coalesce });
  }, []);

  const updateFrame = useCallback((index: number, patch: Partial<Frame>, coalesce?: string) => {
    edit((d) => ({ ...d, frames: d.frames.map((f, i) => (i === index ? { ...f, ...patch } : f)) }), coalesce);
  }, [edit]);

  const updateAction = useCallback((patch: Partial<Pick<Action, 'label' | 'grounded' | 'playback'>>, coalesce?: string) => {
    edit((d) => ({ ...d, ...patch }), coalesce);
  }, [edit]);

  const moveFrame = useCallback((from: number, to: number) => {
    edit((d) => {
      const frames = [...d.frames];
      const [moved] = frames.splice(from, 1);
      frames.splice(to, 0, moved);
      return { ...d, frames };
    });
    setCurrent(to);
  }, [edit]);

  const deleteFrame = useCallback((index: number) => {
    if (!doc) return;
    if (doc.frames.length <= 1) {
      setNotice('至少要保留一帧');
      return;
    }
    edit((d) => ({ ...d, frames: d.frames.filter((_, i) => i !== index) }));
    setCurrent(Math.max(0, Math.min(index, doc.frames.length - 2)));
  }, [doc, edit]);

  const duplicateFrame = useCallback(async (index: number) => {
    if (!doc) return;
    const source = doc.frames[index];
    try {
      const created = await api.duplicateFrame(pid, doc.id, source);
      edit((d) => {
        const at = d.frames.findIndex((f) => f.id === source.id);
        const frames = [...d.frames];
        frames.splice(at + 1, 0, { ...source, ...created, note: '' });
        return { ...d, frames };
      });
      setCurrent(index + 1);
    } catch (error) {
      setNotice(`复制失败：${message(error)}`);
    }
  }, [doc, edit, pid]);

  const setAllDurations = useCallback((duration: number) => {
    edit((d) => ({ ...d, frames: d.frames.map((f) => ({ ...f, duration })) }));
  }, [edit]);

  const align = useCallback((indices: number[], axes: AlignAxes) => {
    if (!qc) return;
    const target = { baseline: Math.round(qc.baseline), centerX: qc.centerX };
    edit((d) => {
      let changed = false;
      const frames = d.frames.map((f, i) => {
        const image = images.get(urlOf(f));
        if (!indices.includes(i) || !image || image.stats.empty) return f;
        const offset = alignedOffset(f, image, target, axes);
        if (offset[0] === f.offset[0] && offset[1] === f.offset[1]) return f;
        changed = true;
        return { ...f, offset };
      });
      return changed ? { ...d, frames } : d;
    });
  }, [qc, images, urlOf, edit]);

  const replaceImage = useCallback(async (index: number, file: File) => {
    if (!doc) return;
    const frame = doc.frames[index];
    try {
      const { version } = await api.uploadVersion(pid, doc.id, frame.id, file);
      await loadImage(frameUrl(pid, doc.id, frame.id, version));
      edit((d) => ({
        ...d,
        frames: d.frames.map((f) => (f.id === frame.id
          ? { ...f, version, versions: [...new Set([...f.versions, version])].sort((a, b) => a - b) }
          : f)),
      }));
    } catch (error) {
      setNotice(`上传失败：${message(error)}`);
    }
  }, [doc, edit, pid]);

  const nextProblem = useCallback(() => {
    if (!qc || !frameCount) return;
    for (let k = 1; k <= frameCount; k += 1) {
      const i = (current + k) % frameCount;
      if (qc.frames[i]?.flags.some((f) => f.level === 'warn')) {
        setPlaying(false);
        setCurrent(i);
        return;
      }
    }
    setNotice('这个动作没有需要注意的帧了');
  }, [qc, frameCount, current]);

  const runExport = useCallback(async (options: ExportOptions) => {
    if (!doc) throw new Error('没有打开的动作');
    await flushSave();
    return api.exportAction(pid, doc.id, options);
  }, [doc, flushSave, pid]);

  // ---- AI jobs -------------------------------------------------------------
  const docIdRef = useRef(docId);
  docIdRef.current = docId;
  const previousJobs = useRef<Map<string, Job['status']>>(new Map());
  const refreshJobs = useCallback(async () => {
    if (!pid || !docId) return;
    try {
      const list = await api.listJobs(pid, docId);
      if (docIdRef.current !== docId) return;
      for (const job of list) {
        const before = previousJobs.current.get(job.id);
        if (before && before !== job.status && !jobActive(job) && job.status === 'done') {
          const index = doc ? doc.frames.findIndex((f) => f.id === job.frame) : -1;
          setNotice(`第 ${index + 1} 帧的 AI 候选生成好了`);
        }
      }
      previousJobs.current = new Map(list.map((job) => [job.id, job.status]));
      setJobs(list);
    } catch {
      // Polling failures are transient; the next tick retries.
    }
  }, [pid, docId, doc]);

  useEffect(() => { void refreshJobs(); }, [pid, docId]); // eslint-disable-line react-hooks/exhaustive-deps
  const anyJobActive = jobs.some(jobActive);
  useEffect(() => {
    if (!anyJobActive) return undefined;
    const timer = window.setInterval(() => { void refreshJobs(); }, 2000);
    return () => window.clearInterval(timer);
  }, [anyJobActive, refreshJobs]);

  const currentFrameId = doc?.frames[Math.min(current, (doc?.frames.length ?? 1) - 1)]?.id;
  useEffect(() => {
    setRepairRect(null);
    setSelecting(false);
  }, [currentFrameId]);

  const aiState = useMemo(() => {
    const state: Record<string, 'running' | 'ready' | undefined> = {};
    for (const job of jobs) {
      if (jobActive(job)) state[job.frame] = 'running';
      else if (job.status === 'done' && !job.reviewed && state[job.frame] !== 'running') state[job.frame] = 'ready';
    }
    return state;
  }, [jobs]);

  const submitJob = useCallback(async (request: { kind: JobKind; instruction: string; candidates: number }) => {
    if (!doc) return;
    const frame = doc.frames[current];
    await flushSave();
    try {
      const job = await api.createJob(pid, doc.id, frame.id, { ...request, rect: request.kind === 'repair' ? repairRect : null });
      previousJobs.current.set(job.id, job.status);
      setJobs((prev) => [job, ...prev]);
      setSelecting(false);
    } catch (error) {
      setNotice(`提交失败：${message(error)}`);
    }
  }, [doc, current, flushSave, pid, repairRect]);

  const previewCandidate = useCallback((job: Job, index: number) => {
    if (!doc) return;
    if (preview?.jobId === job.id && preview.index === index) {
      setPreview(null);
      return;
    }
    const frameIndex = doc.frames.findIndex((f) => f.id === job.frame);
    if (frameIndex < 0) {
      setNotice('这一帧已经被删除了');
      return;
    }
    setPreview({ jobId: job.id, index, frameId: job.frame, url: candidateUrl(pid, job, index) });
    setPlaying(false);
    setCurrent(frameIndex);
  }, [doc, preview, pid]);

  const acceptCandidate = useCallback(async (job: Job, index: number) => {
    try {
      const { version } = await api.acceptCandidate(pid, job.id, index);
      await loadImage(frameUrl(pid, job.action, job.frame, version));
      edit((d) => ({
        ...d,
        frames: d.frames.map((f) => (f.id === job.frame
          ? { ...f, version, versions: [...new Set([...f.versions, version])].sort((a, b) => a - b) }
          : f)),
      }));
      setPreview(null);
      setNotice(`已采用为 v${version}，在"版本"里可以随时换回原来的`);
      void refreshJobs();
    } catch (error) {
      setNotice(`采用失败：${message(error)}`);
    }
  }, [pid, edit, refreshJobs]);

  const cancelJob = useCallback(async (job: Job) => {
    try {
      await api.cancelJob(pid, job.id);
    } finally {
      void refreshJobs();
    }
  }, [pid, refreshJobs]);

  const reviewJob = useCallback(async (job: Job, reviewed: boolean) => {
    try {
      await api.reviewJob(pid, job.id, reviewed);
      if (reviewed && preview?.jobId === job.id) setPreview(null);
    } finally {
      void refreshJobs();
    }
  }, [pid, preview, refreshJobs]);

  // ---- keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (exportOpen) {
        if (event.key === 'Escape') setExportOpen(false);
        return;
      }
      if (event.key === 'Escape') {
        setSelecting(false);
        setPreview(null);
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if (mod && key === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
        return;
      }
      if (mod && key === 'd') {
        event.preventDefault();
        void duplicateFrame(current);
        return;
      }
      if (mod || !doc) return;
      const frame = doc.frames[current];
      if (event.key.startsWith('Arrow') && event.altKey && frame) {
        event.preventDefault();
        const amount = event.shiftKey ? 5 : 1;
        const moves: Record<string, [number, number]> = { ArrowLeft: [-amount, 0], ArrowRight: [amount, 0], ArrowUp: [0, -amount], ArrowDown: [0, amount] };
        const [dx, dy] = moves[event.key] ?? [0, 0];
        setPlaying(false);
        updateFrame(current, { offset: [frame.offset[0] + dx, frame.offset[1] + dy] }, `nudge-${frame.id}`);
        return;
      }
      switch (event.key) {
        case ' ':
          event.preventDefault();
          setPlaying((p) => !p);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          step(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          step(1);
          break;
        case '[':
        case ']':
          if (frame) {
            const duration = Math.max(10, Math.min(10000, frame.duration + (event.key === ']' ? 10 : -10)));
            updateFrame(current, { duration }, `dur-${frame.id}`);
          }
          break;
        case 'h':
        case 'H':
          if (frame) updateFrame(current, { flipX: !frame.flipX });
          break;
        case 'o':
        case 'O':
          setView((v) => (v.onionPrev || v.onionNext ? { ...v, onionPrev: 0, onionNext: 0 } : { ...v, onionPrev: 1, onionNext: 1 }));
          break;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          deleteFrame(current);
          break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc, current, exportOpen, step, updateFrame, deleteFrame, duplicateFrame]);

  // ---- render --------------------------------------------------------------
  if (loadError) return <div className="empty-state"><p>{loadError}</p></div>;
  if (!project || !doc || !qc) return <div className="empty-state"><p>加载中…</p></div>;

  const problemFrames = qc.frames.filter((f) => f.flags.some((flag) => flag.level === 'warn')).length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>Sprite Studio</strong>
          <span className="muted">{project.name} / {doc.label}</span>
        </div>
        <div className="transport">
          <button onClick={() => step(-1)} title="上一帧（←）">⏮</button>
          <button className="play" onClick={() => setPlaying((p) => !p)} title="播放 / 暂停（空格）">{playing ? '⏸' : '▶'}</button>
          <button onClick={() => step(1)} title="下一帧（→）">⏭</button>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="播放速度">
            {[0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </div>
        <div className="view-opts">
          <label>缩放
            <select value={String(view.zoom)} onChange={(e) => setView({ ...view, zoom: e.target.value === 'fit' ? 'fit' : Number(e.target.value) })}>
              <option value="fit">适应</option>
              {[1, 2, 3, 4].map((z) => <option key={z} value={z}>{z * 100}%</option>)}
            </select>
          </label>
          <label>背景
            <select value={view.background} onChange={(e) => setView({ ...view, background: e.target.value })}>
              {BACKGROUNDS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
          </label>
          <label title="洋葱皮：半透明显示前后帧（红=前，蓝=后），按 O 开关">洋葱皮
            <select value={view.onionPrev} onChange={(e) => setView({ ...view, onionPrev: Number(e.target.value) })}>
              {[0, 1, 2].map((v) => <option key={v} value={v}>前 {v}</option>)}
            </select>
            <select value={view.onionNext} onChange={(e) => setView({ ...view, onionNext: Number(e.target.value) })}>
              {[0, 1, 2].map((v) => <option key={v} value={v}>后 {v}</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={view.guides} onChange={(e) => setView({ ...view, guides: e.target.checked })} />参考线</label>
        </div>
        <div className="doc-opts">
          <button onClick={() => dispatch({ type: 'undo' })} disabled={!history.past.length} title="撤销（⌘Z）">↶</button>
          <button onClick={() => dispatch({ type: 'redo' })} disabled={!history.future.length} title="重做（⇧⌘Z）">↷</button>
          <span className={`save-state ${saveState}`}>{SAVE_LABELS[saveState]}</span>
          <button className="primary" onClick={() => { void flushSave(); setPlaying(false); setExportOpen(true); }}>导出</button>
        </div>
      </header>

      <div className="workspace">
        <ActionList actions={summaries} warnings={warnings} current={doc.id} onSelect={(id) => { void selectAction(id); }} />
        <main className="center">
          <Viewer
            action={doc}
            index={Math.min(current, doc.frames.length - 1)}
            images={images}
            urlOf={urlOf}
            qc={qc}
            view={view}
            playing={playing}
            onOffset={(index, offset, coalesce) => updateFrame(index, { offset }, coalesce)}
            selecting={selecting}
            rect={aiMode === 'repair' ? repairRect : null}
            onRect={setRepairRect}
            onSelectEnd={() => setSelecting(false)}
            banner={preview && (
              <div className="preview-banner">
                <span>正在预览第 {doc.frames.findIndex((f) => f.id === preview.frameId) + 1} 帧的候选 {preview.index}（播放可以看动画效果）</span>
                <button
                  className="primary"
                  onClick={() => {
                    const job = jobs.find((j) => j.id === preview.jobId);
                    if (job) void acceptCandidate(job, preview.index);
                  }}
                >
                  采用
                </button>
                <button onClick={() => setPreview(null)}>退出预览（Esc）</button>
              </div>
            )}
          />
          <div className="timeline-panel">
            <div className="timeline-tools">
              <button onClick={() => { void duplicateFrame(current); }} title="⌘D">复制帧</button>
              <button onClick={() => deleteFrame(current)} disabled={doc.frames.length <= 1} title="Delete">删除帧</button>
              <button onClick={() => updateFrame(current, { flipX: !doc.frames[current]?.flipX })} title="H">水平翻转</button>
              <button onClick={() => moveFrame(current, current - 1)} disabled={current === 0}>← 前移</button>
              <button onClick={() => moveFrame(current, current + 1)} disabled={current >= doc.frames.length - 1}>后移 →</button>
              <span className="spacer" />
              <span className={problemFrames ? 'warn-text' : 'ok'}>{problemFrames ? `${problemFrames} 帧需要注意` : '没有发现问题'}</span>
              <button onClick={nextProblem} disabled={!problemFrames}>下一个问题帧</button>
              <span className="legend muted">格子宽度 = 显示时长 · 帧之间的竖条 = 画面变化量（红 = 跳变，蓝 = 几乎没变）</span>
            </div>
            <Timeline action={doc} current={current} qc={qc} urlOf={urlOf} aiState={aiState} onSelect={(i) => { setPlaying(false); setCurrent(i); }} onMove={moveFrame} />
          </div>
        </main>
        <Inspector
          action={doc}
          index={Math.min(current, doc.frames.length - 1)}
          qc={qc}
          versionUrl={(frame, version) => frameUrl(pid, doc.id, frame.id, version)}
          onUpdateAction={updateAction}
          onUpdateFrame={updateFrame}
          onSetAllDurations={setAllDurations}
          onAlign={align}
          onReplace={replaceImage}
          aiPanel={doc.frames[current] && (
            <AiPanel
              key={doc.frames[current].id}
              frame={doc.frames[current]}
              codex={codexStatus}
              jobs={jobs.filter((job) => job.frame === doc.frames[current].id)}
              mode={aiMode}
              onMode={(mode) => { setAiMode(mode); if (mode === 'redraw') setSelecting(false); }}
              rect={repairRect}
              selecting={selecting}
              onToggleSelect={() => { setPlaying(false); setSelecting((s) => !s); }}
              onClearRect={() => setRepairRect(null)}
              onSubmit={submitJob}
              preview={preview ? { jobId: preview.jobId, index: preview.index } : null}
              onPreview={previewCandidate}
              onAccept={(job, index) => { void acceptCandidate(job, index); }}
              onCancel={(job) => { void cancelJob(job); }}
              onReview={(job, reviewed) => { void reviewJob(job, reviewed); }}
              candidateSrc={(job, index) => candidateUrl(pid, job, index)}
            />
          )}
        />
      </div>

      {notice && <div className="toast" onClick={() => setNotice(null)}>{notice}</div>}
      {exportOpen && <ExportDialog actionLabel={doc.label} onClose={() => setExportOpen(false)} onExport={runExport} />}
    </div>
  );
}

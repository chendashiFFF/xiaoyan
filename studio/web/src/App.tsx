import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, candidateUrl, frameUrl, jobFileUrl, projectFileUrl } from './api';
import { ActionList } from './components/ActionList';
import { AiPanel } from './components/AiPanel';
import { CandidateBar } from './components/CandidateBar';
import { CharacterMenu } from './components/CharacterMenu';
import { NewCharacterDialog, type NewCharacterRequest } from './components/NewCharacterDialog';
import { ReferencesDialog } from './components/ReferencesDialog';
import { ExportDialog } from './components/ExportDialog';
import { Inspector, type AlignAxes } from './components/Inspector';
import { KeyposePanel } from './components/KeyposePanel';
import { NewActionDialog } from './components/NewActionDialog';
import { GeneratorSettingsDialog } from './components/GeneratorSettingsDialog';
import { Timeline } from './components/Timeline';
import { Viewer, type ViewSettings } from './components/Viewer';
import { historyReducer, initialHistory } from './history';
import { loadImage, useImages } from './images';
import { alignedOffset, computeQc } from './qc';
import type { Action, ExportOptions, GeneratorSettings, Frame, FrameJobKind, Job, KeyposeRequest, NewActionRequest, Playback, Project, ProjectSummary, Rect, ReferenceRole } from './types';

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
  kind: Job['kind'];
  /** redraw/repair: the frame shown with the candidate; inbetween: the frame the candidate follows */
  frameId: string;
  url: string;
}

/** Id of the not-yet-accepted in-between that is spliced into the view while previewing. */
const PREVIEW_FRAME = 'preview-inbetween';

function splitDuration(duration: number, keepTotal: boolean): [number, number] {
  if (!keepTotal) return [duration, duration];
  return [Math.max(10, Math.ceil(duration / 2)), Math.max(10, Math.floor(duration / 2))];
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
  const [generator, setGenerator] = useState<GeneratorSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [aiMode, setAiMode] = useState<FrameJobKind>('redraw');
  const [keepTotal, setKeepTotal] = useState(true);
  const [newActionOpen, setNewActionOpen] = useState(false);
  const [autoNext, setAutoNext] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [refsOpen, setRefsOpen] = useState(false);
  const [newCharacterOpen, setNewCharacterOpen] = useState(false);
  const [refsSources, setRefsSources] = useState<string[] | undefined>(undefined);
  const [repairRect, setRepairRect] = useState<Rect | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const pid = project?.id ?? '';

  // ---- loading -------------------------------------------------------------
  const openProject = useCallback(async (pidToLoad: string, aid?: string) => {
    const loaded = await api.getProject(pidToLoad);
    const docs = await Promise.all(loaded.actions.map((a) => api.getAction(loaded.id, a.id)));
    dispatch({ type: 'clear' });
    setPreview(null);
    setJobs([]);
    setPlaying(false);
    setCurrent(0);
    setProject(loaded);
    setActions(Object.fromEntries(docs.map((d) => [d.id, d])));
    const first = loaded.actions.find((a) => a.id === aid)?.id ?? loaded.actions[0]?.id ?? null;
    setActionId(first);
    if (!first) window.history.replaceState(null, '', `#/${loaded.id}`);
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch {
      // The character menu just keeps its previous list.
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const list = await api.listProjects();
        setProjects(list);
        if (!list.length) {
          setLoadError('还没有人物。先在仓库根目录运行 npm run studio:import 导入现有动作。');
          return;
        }
        const hash = parseHash();
        await openProject(list.find((p) => p.id === hash.pid)?.id ?? list[0].id, hash.aid);
      } catch (error) {
        setLoadError(`加载失败：${message(error)}。后端是否已启动（npm run studio）？`);
      }
    })();
    api.getSettings().then(setGenerator, () => setGenerator(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  useEffect(() => {
    const onHash = () => {
      const { aid } = parseHash();
      if (aid && aid !== actionId && actionsRef.current[aid]) void selectAction(aid);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [actionId, selectAction]);

  // ---- images & checks -----------------------------------------------------
  const docId = doc?.id ?? '';
  const locked = preview?.kind === 'inbetween';
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // While an in-between is previewed it is spliced into the view (not the document) after its frame.
  const viewDoc = useMemo(() => {
    if (!doc || !preview || preview.kind !== 'inbetween') return doc;
    const at = doc.frames.findIndex((f) => f.id === preview.frameId);
    if (at < 0) return doc;
    const before = doc.frames[at];
    const [kept, given] = splitDuration(before.duration, keepTotal);
    const frames = [...doc.frames];
    frames.splice(at, 1, { ...before, duration: kept }, {
      id: PREVIEW_FRAME, duration: given, offset: [before.offset[0], before.offset[1]], flipX: false, version: 1, versions: [1], note: '',
    });
    return { ...doc, frames };
  }, [doc, preview, keepTotal]);
  const urlOf = useCallback((frame: Frame) => {
    if (preview && (preview.kind === 'inbetween' ? frame.id === PREVIEW_FRAME : frame.id === preview.frameId)) return preview.url;
    return frameUrl(pid, docId, frame.id, frame.version);
  }, [pid, docId, preview]);
  const allUrls = useMemo(() => {
    const urls = new Set<string>();
    viewDoc?.frames.forEach((f) => urls.add(urlOf(f)));
    Object.values(actions).forEach((a) => a.frames.forEach((f) => urls.add(frameUrl(pid, a.id, f.id, f.version))));
    return [...urls];
  }, [actions, viewDoc, urlOf, pid]);
  const images = useImages(allUrls);
  const loadedCount = images.size;

  const qc = useMemo(
    () => (viewDoc ? computeQc(viewDoc, images, urlOf) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewDoc, loadedCount, urlOf],
  );
  const warnings = useMemo(() => {
    const result: Record<string, number | undefined> = {};
    for (const action of Object.values(actions)) {
      const source = action.id === doc?.id ? doc : action;
      const url = (f: Frame) => frameUrl(pid, source.id, f.id, f.version);
      result[action.id] = source.frames.length && source.frames.every((f) => images.has(url(f))) ? computeQc(source, images, url).warnCount : undefined;
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
  const frameCount = viewDoc?.frames.length ?? 0;
  useEffect(() => {
    if (current >= frameCount && frameCount) setCurrent(frameCount - 1);
  }, [current, frameCount]);

  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    const shown = viewDoc;
    if (!playing || !shown || !shown.frames.length) return undefined;
    let raf = 0;
    let last = performance.now();
    let elapsed = 0;
    let direction = 1;
    let index = Math.min(currentRef.current, shown.frames.length - 1);
    const tick = (now: number) => {
      elapsed += (now - last) * speed;
      last = now;
      let guard = 0;
      while (elapsed >= shown.frames[index].duration && guard < 100) {
        elapsed -= shown.frames[index].duration;
        [index, direction] = advance(index, direction, shown.frames.length, shown.playback);
        guard += 1;
      }
      setCurrent(index);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, viewDoc, speed]);

  const step = useCallback((delta: number) => {
    setPlaying(false);
    if (frameCount) setCurrent((i) => (i + delta + frameCount) % frameCount);
  }, [frameCount]);

  // ---- edits ---------------------------------------------------------------
  const blocked = useCallback(() => {
    if (lockedRef.current) setNotice('正在预览补帧：先采用或退出预览（Esc）再编辑');
    return lockedRef.current;
  }, []);

  const edit = useCallback((update: (d: Action) => Action, coalesce?: string) => {
    if (blocked()) return;
    dispatch({ type: 'edit', update, coalesce });
  }, [blocked]);

  const updateFrame = useCallback((index: number, patch: Partial<Frame>, coalesce?: string) => {
    edit((d) => ({ ...d, frames: d.frames.map((f, i) => (i === index ? { ...f, ...patch } : f)) }), coalesce);
  }, [edit]);

  const updateAction = useCallback((patch: Partial<Pick<Action, 'label' | 'grounded' | 'playback'>>, coalesce?: string) => {
    edit((d) => ({ ...d, ...patch }), coalesce);
  }, [edit]);

  const moveFrame = useCallback((from: number, to: number) => {
    if (blocked()) return;
    edit((d) => {
      const frames = [...d.frames];
      const [moved] = frames.splice(from, 1);
      frames.splice(to, 0, moved);
      return { ...d, frames };
    });
    setCurrent(to);
    setNotice(`已把这一帧从第 ${from + 1} 位挪到第 ${to + 1} 位（⌘Z 撤销）`);
  }, [edit, blocked]);

  const deleteFrame = useCallback((index: number) => {
    if (!doc || blocked()) return;
    if (doc.frames.length <= 1) {
      setNotice('至少要保留一帧');
      return;
    }
    edit((d) => ({ ...d, frames: d.frames.filter((_, i) => i !== index) }));
    setCurrent(Math.max(0, Math.min(index, doc.frames.length - 2)));
  }, [doc, edit, blocked]);

  const duplicateFrame = useCallback(async (index: number) => {
    if (!doc || blocked()) return;
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
  }, [doc, edit, pid, blocked]);

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
    if (!doc || blocked()) return;
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
  }, [doc, edit, pid, blocked]);

  const insertBetween = useCallback((index: number) => {
    if (blocked()) return;
    setPlaying(false);
    setCurrent(index);
    setAiMode('inbetween');
    setSelecting(false);
    // Bring the in-between controls into view and make the next click the obvious one.
    window.setTimeout(() => {
      const panel = document.querySelector('.ai-panel');
      panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const button = panel?.querySelector<HTMLButtonElement>('button.primary.grow');
      button?.classList.remove('flash');
      void button?.offsetWidth;
      button?.classList.add('flash');
      button?.focus({ preventScroll: true });
    }, 60);
  }, [blocked]);

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
          setNotice(job.kind === 'keyposes' ? '关键姿势生成好了，挑一组采用吧'
            : job.kind === 'inbetween' ? `第 ${index + 1} 帧后面的过渡帧生成好了` : `第 ${index + 1} 帧的 AI 候选生成好了`);
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
      if (!job.frame) continue;
      if (jobActive(job)) state[job.frame] = 'running';
      else if (job.status === 'done' && !job.reviewed && state[job.frame] !== 'running') state[job.frame] = 'ready';
    }
    return state;
  }, [jobs]);

  const submitJob = useCallback(async (request: { kind: FrameJobKind; instruction: string; candidates: number }) => {
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

  const exitPreview = useCallback(() => {
    if (preview?.kind === 'inbetween' && doc) {
      // Indices after the spliced-in frame shift back by one once it is gone.
      const at = doc.frames.findIndex((f) => f.id === preview.frameId);
      setCurrent((c) => (c > at ? c - 1 : c));
    }
    setPreview(null);
  }, [preview, doc]);

  const previewCandidate = useCallback((job: Job, index: number) => {
    if (!doc || !job.frame) return;
    if (preview?.jobId === job.id && preview.index === index) {
      exitPreview();
      return;
    }
    const at = doc.frames.findIndex((f) => f.id === job.frame);
    if (at < 0) {
      setNotice('这一帧已经被删除了');
      return;
    }
    setPreview({ jobId: job.id, index, kind: job.kind, frameId: job.frame, url: candidateUrl(pid, job, index) });
    setPlaying(false);
    setCurrent(job.kind === 'inbetween' ? at + 1 : at);
  }, [doc, preview, pid, exitPreview]);

  const acceptCandidate = useCallback(async (job: Job, index: number) => {
    if (!doc) return;
    try {
      const result = await api.acceptCandidate(pid, job.id, index);
      // Straight to the reducer: accepting is what ends the edit lock of an in-between preview.
      if (result.kind === 'keyposes') {
        dispatch({ type: 'edit', update: (d) => ({ ...d, frames: [...d.frames, ...result.frames] }) });
        setCurrent(doc.frames.length);
        setNotice(`已加入 ${result.frames.length} 个关键姿势。下一步：选中一帧，用"补中间帧"补过渡`);
      } else if (result.kind === 'inbetween') {
        const at = doc.frames.findIndex((f) => f.id === result.after);
        dispatch({
          type: 'edit',
          update: (d) => {
            const where = d.frames.findIndex((f) => f.id === result.after);
            const frames = [...d.frames];
            if (where < 0) return { ...d, frames: [...frames, result.frame] };
            const before = frames[where];
            const [kept, given] = splitDuration(before.duration, keepTotal);
            frames.splice(where, 1, { ...before, duration: kept }, {
              ...result.frame, duration: given, offset: [before.offset[0], before.offset[1]],
            });
            return { ...d, frames };
          },
        });
        setCurrent(at >= 0 ? at + 1 : doc.frames.length);
        setNotice('已插入过渡帧');
      } else if (result.kind === 'redraw' || result.kind === 'repair') {
        await loadImage(frameUrl(pid, job.action, result.frame, result.version));
        dispatch({
          type: 'edit',
          update: (d) => ({
            ...d,
            frames: d.frames.map((f) => (f.id === result.frame
              ? { ...f, version: result.version, versions: [...new Set([...f.versions, result.version])].sort((a, b) => a - b) }
              : f)),
          }),
        });
        setNotice(`已采用为 v${result.version}，在"版本"里可以随时换回原来的`);
      }
      setPreview(null);
      setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, reviewed: true } : j)));
      setAutoNext(true);
      void refreshJobs();
    } catch (error) {
      setNotice(`采用失败：${message(error)}`);
    }
  }, [doc, pid, keepTotal, refreshJobs]);

  const generateKeyposes = useCallback(async (request: KeyposeRequest) => {
    if (!doc) return;
    try {
      const job = await api.createKeyposes(pid, doc.id, request);
      previousJobs.current.set(job.id, job.status);
      setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    } catch (error) {
      setNotice(`提交失败：${message(error)}`);
    }
  }, [doc, pid]);

  const switchProject = useCallback(async (id: string) => {
    await flushSave();
    try {
      await openProject(id);
      void refreshProjects();
    } catch (error) {
      setNotice(`切换失败：${message(error)}`);
    }
  }, [flushSave, openProject, refreshProjects]);

  const createCharacter = useCallback(async (request: NewCharacterRequest) => {
    await flushSave();
    const created = await api.createProject({ id: request.id, name: request.name });
    if (request.identity) {
      const identity = await api.uploadReference(created.id, request.identity, 'identity');
      let warning = identity.warning;
      if (request.design) warning = (await api.uploadReference(created.id, request.design, 'design')).warning ?? warning;
      setNewCharacterOpen(false);
      await openProject(created.id);
      await refreshProjects();
      setNotice(warning ?? `人物「${created.name}」已创建。下一步：左边"＋ 新动作"`);
      return;
    }
    // AI mode: keep the loose images as references and ask for a clean master reference.
    const sources: string[] = [];
    for (const file of request.sources) sources.push((await api.uploadReference(created.id, file, null)).reference);
    const fromOther = request.style.startsWith('from:');
    await api.createReferenceJob(created.id, {
      kind: 'master', sources, instruction: request.notes, candidates: 2,
      style: fromOther ? 'pixel' : (request.style as 'pixel' | 'source'), styleFrom: fromOther ? request.style.slice(5) : null,
    });
    setNewCharacterOpen(false);
    await openProject(created.id);
    await refreshProjects();
    setRefsSources(sources);
    setRefsOpen(true);
    setNotice('AI 正在画主参考图，好了在这里挑一张');
  }, [flushSave, openProject, refreshProjects]);

  const uploadSource = useCallback(async (file: File) => {
    if (!project) throw new Error('没有打开的人物');
    const result = await api.uploadReference(project.id, file, null);
    setProject((prev) => prev && { ...prev, ...result.project, actions: prev.actions });
    return result.reference;
  }, [project]);

  const applyProject = useCallback((updated: Project) => {
    setProject((prev) => prev && { ...prev, ...updated, actions: prev.actions });
    void refreshProjects();
  }, [refreshProjects]);

  const deleteCharacter = useCallback(async () => {
    if (!project) return;
    const count = project.actions.length;
    if (!window.confirm(`删除人物「${project.name}」和它的 ${count} 个动作？\n整个文件夹会移到 studio/projects/.trash/，需要时可以从那里找回。`)) return;
    await flushSave();
    try {
      const { trashedTo, next } = await api.deleteProject(project.id);
      await openProject(next);
      await refreshProjects();
      setNotice(`已删除「${project.name}」，文件移到了 ${trashedTo}`);
    } catch (error) {
      setNotice(`删除失败：${message(error)}`);
    }
  }, [project, flushSave, openProject, refreshProjects]);

  const uploadReference = useCallback(async (file: File, role: ReferenceRole) => {
    if (!project) return null;
    const result = await api.uploadReference(project.id, file, role);
    setProject((prev) => prev && { ...prev, ...result.project, actions: prev.actions });
    void refreshProjects();
    return result.warning;
  }, [project, refreshProjects]);

  const assignReference = useCallback(async (role: ReferenceRole, rel: string | null) => {
    if (!project) return;
    const updated = await api.updateProject(project.id, role === 'identity' ? { identityReference: rel } : { designReference: rel });
    setProject((prev) => prev && { ...prev, ...updated, actions: prev.actions });
    void refreshProjects();
  }, [project, refreshProjects]);

  const deleteAction = useCallback(async () => {
    if (!doc || !project) return;
    if (!window.confirm(`删除动作「${doc.label}」？文件会移到项目的 trash 目录，需要时可以从那里找回。`)) return;
    await flushSave();
    try {
      const { trashedTo } = await api.deleteAction(pid, doc.id);
      const remaining = project.actions.filter((a) => a.id !== doc.id);
      setProject({ ...project, actions: remaining });
      setActions((prev) => {
        const next = { ...prev };
        delete next[doc.id];
        return next;
      });
      setActionId(remaining[0]?.id ?? null);
      setNotice(`已删除，文件移到了 ${trashedTo}`);
    } catch (error) {
      setNotice(`删除失败：${message(error)}`);
    }
  }, [doc, project, pid, flushSave]);

  const createNewAction = useCallback(async (body: NewActionRequest, keyposes: KeyposeRequest) => {
    await flushSave();
    const action = await api.createAction(pid, body);
    setProject((prev) => prev && {
      ...prev,
      actions: [...prev.actions, { id: action.id, label: action.label, cellSize: action.cellSize, frameCount: 0, duration: 0, thumb: null }],
    });
    setActions((prev) => ({ ...prev, [action.id]: action }));
    setNewActionOpen(false);
    setActionId(action.id);
    try {
      const job = await api.createKeyposes(pid, action.id, keyposes);
      previousJobs.current.set(job.id, job.status);
      if (docIdRef.current === action.id) setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    } catch (error) {
      setNotice(`动作已创建，但关键姿势没能开始生成：${message(error)}`);
    }
  }, [flushSave, pid]);

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
      setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, reviewed } : j)));
      if (reviewed && preview?.jobId === job.id) {
        exitPreview();
        setAutoNext(true);
      }
    } finally {
      void refreshJobs();
    }
  }, [pid, preview, refreshJobs, exitPreview]);

  // Finished candidates nobody has decided on yet, in timeline order: the review queue.
  const waitingJobs = useMemo(() => {
    if (!doc) return [];
    const position = new Map(doc.frames.map((f, i) => [f.id, i]));
    return jobs
      .filter((j) => j.kind !== 'keyposes' && j.status === 'done' && !j.reviewed && j.frame && position.has(j.frame)
        && j.candidates.some((c) => c.status === 'done'))
      .sort((a, b) => (position.get(a.frame!)! - position.get(b.frame!)!) || a.createdAt - b.createdAt);
  }, [jobs, doc]);

  const reviewNext = useCallback((skipJobId?: string) => {
    const queue = waitingJobs.filter((j) => j.id !== skipJobId);
    const job = queue[0];
    if (!job) return false;
    const first = job.candidates.find((c) => c.status === 'done');
    if (first) previewCandidate(job, first.index);
    return true;
  }, [waitingJobs, previewCandidate]);

  // After accepting or rejecting, move straight on to the next waiting set (runs after the doc has updated).
  useEffect(() => {
    if (!autoNext || preview) return;
    setAutoNext(false);
    if (reviewNext()) setNotice(`下一组候选（还剩 ${waitingJobs.length} 组待看）`);
  }, [autoNext, preview, reviewNext, waitingJobs.length]);

  const inbetweenGaps = useMemo(() => {
    if (!doc || doc.frames.length < 2) return [];
    const busy = new Set(jobs
      .filter((j) => j.kind === 'inbetween' && (jobActive(j) || (j.status === 'done' && !j.reviewed)))
      .map((j) => `${j.frame}>${j.frameB}`));
    const gaps: { from: Frame; to: Frame }[] = [];
    doc.frames.forEach((from, i) => {
      const last = i + 1 === doc.frames.length;
      if (last && doc.playback !== 'loop') return;
      const to = doc.frames[last ? 0 : i + 1];
      if (!busy.has(`${from.id}>${to.id}`)) gaps.push({ from, to });
    });
    return gaps;
  }, [doc, jobs]);

  const submitAllInbetweens = useCallback(async (candidates: number) => {
    if (!doc || blocked() || !inbetweenGaps.length) return;
    const total = inbetweenGaps.length * candidates;
    if (!window.confirm(`给 ${inbetweenGaps.length} 个间隔各补一帧，每处 ${candidates} 张候选，一共生成 ${total} 张图，会消耗 ${total} 次生图额度。继续吗？`)) return;
    await flushSave();
    const created: Job[] = [];
    for (const gap of inbetweenGaps) {
      try {
        const job = await api.createJob(pid, doc.id, gap.from.id, { kind: 'inbetween', instruction: '', candidates });
        previousJobs.current.set(job.id, job.status);
        created.push(job);
      } catch (error) {
        setNotice(`有一处没能提交：${message(error)}`);
      }
    }
    setJobs((prev) => [...created, ...prev]);
    if (created.length) setNotice(`已提交 ${created.length} 处补帧，好了之后点"逐个看候选"或等提示`);
  }, [doc, blocked, inbetweenGaps, flushSave, pid]);

  // ---- keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (exportOpen || newActionOpen || refsOpen || newCharacterOpen || settingsOpen) {
        if (event.key === 'Escape') {
          setSettingsOpen(false);
          setExportOpen(false);
          setNewActionOpen(false);
          setRefsOpen(false);
          setNewCharacterOpen(false);
        }
        return;
      }
      if (event.key === 'Escape') {
        setSelecting(false);
        exitPreview();
        return;
      }
      if (preview && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const job = jobs.find((j) => j.id === preview.jobId);
        if (job && /^[1-4]$/.test(event.key)) {
          const pick = job.candidates.find((c) => c.index === Number(event.key) && c.status === 'done');
          if (pick) previewCandidate(job, pick.index);
          event.preventDefault();
          return;
        }
        if (job && event.key === 'Enter') {
          event.preventDefault();
          void acceptCandidate(job, preview.index);
          return;
        }
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
  }, [doc, current, exportOpen, newActionOpen, refsOpen, newCharacterOpen, settingsOpen, step, updateFrame, deleteFrame, duplicateFrame, exitPreview, preview, jobs, previewCandidate, acceptCandidate]);

  // ---- render --------------------------------------------------------------
  if (loadError) return <div className="empty-state"><p>{loadError}</p></div>;
  if (!project) return <div className="empty-state"><p>加载中…</p></div>;

  const generatorLabel = !generator ? '…'
    : generator.provider === 'api' ? `API · ${generator.api.model}` : `Codex · ${generator.codex.model}`;
  const generatorProblem = !generator ? null
    : generator.provider === 'api'
      ? (!generator.api.base || !generator.api.hasKey ? '图片 API 还没配置好：点右上角「生图设置」填写接口地址和 API Key' : null)
      : (!generator.codex.available ? '没有找到 codex 命令：安装并登录 Codex CLI，或者在「生图设置」里改用图片 API' : null);
  const settingsButton = (
    <button className="ghost" onClick={() => { setPlaying(false); setSettingsOpen(true); }} title="选择用 Codex 还是图片 API 生成图片">⚙ 生图设置</button>
  );

  const characterMenu = (
    <CharacterMenu
      projects={projects}
      current={project.id}
      onSwitch={(id) => { void switchProject(id); }}
      onCreate={() => { setPlaying(false); setNewCharacterOpen(true); }}
      onReferences={() => { setPlaying(false); setRefsOpen(true); }}
      onDelete={() => { setPlaying(false); void deleteCharacter(); }}
    />
  );
  const dialogs = (
    <>
      {notice && <div className="toast" onClick={() => setNotice(null)}>{notice}</div>}
      {exportOpen && doc && <ExportDialog actionLabel={doc.label} onClose={() => setExportOpen(false)} onExport={runExport} />}
      {newActionOpen && (
        <NewActionDialog existingIds={Object.keys(actions)} onClose={() => setNewActionOpen(false)} onCreate={createNewAction} />
      )}
      {settingsOpen && generator && (
        <GeneratorSettingsDialog
          settings={generator}
          onClose={() => setSettingsOpen(false)}
          onSaved={(saved) => { setGenerator(saved); setSettingsOpen(false); setNotice(saved.provider === 'api' ? `已改用图片 API（${saved.api.model}）` : '已改用本机 Codex'); }}
        />
      )}
      {newCharacterOpen && (
        <NewCharacterDialog existingIds={projects.map((p) => p.id)} projects={projects} onClose={() => setNewCharacterOpen(false)} onCreate={createCharacter} />
      )}
      {refsOpen && (
        <ReferencesDialog
          project={project}
          fileUrl={(rel) => projectFileUrl(project.id, rel)}
          onClose={() => { setRefsOpen(false); setRefsSources(undefined); }}
          onUpload={uploadReference}
          onAssign={assignReference}
          projects={projects}
          initialSources={refsSources}
          onUploadSource={uploadSource}
          onProjectChange={applyProject}
        />
      )}
    </>
  );

  if (!doc || !qc) {
    const empty = !project.actions.length;
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand"><strong>Sprite Studio</strong>{characterMenu}</div>
          <div className="doc-opts">{settingsButton}</div>
        </header>
        <div className="workspace no-inspector">
          <ActionList
            actions={summaries}
            warnings={warnings}
            current={null}
            onSelect={(id) => { void selectAction(id); }}
            onCreate={() => { setPlaying(false); setNewActionOpen(true); }}
          />
          <main className="center">
            <div className="empty-state">
              <p>{empty ? `「${project.name}」还没有动作。点左上角"＋ 新动作"，让 AI 先画几个关键姿势。` : '加载中…'}</p>
            </div>
          </main>
        </div>
        {dialogs}
      </div>
    );
  }

  const problemFrames = qc.frames.filter((f) => f.flags.some((flag) => flag.level === 'warn')).length;
  const shown = viewDoc ?? doc;
  const index = Math.max(0, Math.min(current, shown.frames.length - 1));
  const selectedFrame: Frame | undefined = shown.frames[index];
  const docIndex = selectedFrame ? doc.frames.findIndex((f) => f.id === selectedFrame.id) : -1;
  const nextLabel = docIndex < 0 ? null
    : docIndex + 1 < doc.frames.length ? `第 ${docIndex + 2} 帧`
      : doc.playback === 'loop' && doc.frames.length >= 2 ? '第 1 帧' : null;
  const previewAt = preview ? doc.frames.findIndex((f) => f.id === preview.frameId) + 1 : 0;
  const previewJob = preview ? jobs.find((j) => j.id === preview.jobId) : undefined;
  const previewLabel = preview?.kind === 'inbetween'
    ? `第 ${previewAt} 帧后面的过渡帧`
    : `第 ${previewAt} 帧的${preview?.kind === 'repair' ? '局部修补' : '重画'}候选`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>Sprite Studio</strong>
          {characterMenu}
          <span className="muted">/ {doc.label}</span>
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
          {settingsButton}
          <span className={`save-state ${saveState}`}>{SAVE_LABELS[saveState]}</span>
          <button className="primary" onClick={() => { void flushSave(); setPlaying(false); setExportOpen(true); }}>导出</button>
        </div>
      </header>

      <div className="workspace">
        <ActionList
          actions={summaries}
          warnings={warnings}
          current={doc.id}
          onSelect={(id) => { void selectAction(id); }}
          onCreate={() => { setPlaying(false); setNewActionOpen(true); }}
        />
        <main className="center">
          {!doc.frames.length ? (
            <KeyposePanel
              key={doc.id}
              action={doc}
              jobs={jobs.filter((job) => job.kind === 'keyposes')}
              fileUrl={(job, name) => jobFileUrl(pid, job, name)}
              onAccept={acceptCandidate}
              onCancel={(job) => { void cancelJob(job); }}
              onGenerate={generateKeyposes}
            />
          ) : (
            <>
              <Viewer
                action={shown}
                index={index}
                images={images}
                urlOf={urlOf}
                qc={qc}
                view={view}
                playing={playing}
                onOffset={(i, offset, coalesce) => updateFrame(i, { offset }, coalesce)}
                selecting={selecting}
                rect={aiMode === 'repair' && !locked ? repairRect : null}
                onRect={setRepairRect}
                onSelectEnd={() => setSelecting(false)}
                banner={preview && previewJob && (
                  <CandidateBar
                    job={previewJob}
                    index={preview.index}
                    title={previewLabel}
                    waiting={waitingJobs.filter((j) => j.id !== previewJob.id).length}
                    candidateSrc={(job, i) => candidateUrl(pid, job, i)}
                    onPick={(i) => previewCandidate(previewJob, i)}
                    onAccept={() => { void acceptCandidate(previewJob, preview.index); }}
                    onDismiss={() => { void reviewJob(previewJob, true); }}
                    onNext={() => { exitPreview(); reviewNext(previewJob.id); }}
                    onExit={exitPreview}
                  />
                )}
              />
              <div className="timeline-panel">
                <div className="timeline-tools">
                  <button onClick={() => step(-1)} title="切换到上一帧（←）">◀ 上一帧</button>
                  <button onClick={() => step(1)} title="切换到下一帧（→）">下一帧 ▶</button>
                  <span className="tool-sep" />
                  <button onClick={() => { void duplicateFrame(current); }} disabled={locked} title="⌘D">复制帧</button>
                  <button onClick={() => deleteFrame(current)} disabled={locked || doc.frames.length <= 1} title="Delete">删除帧</button>
                  <button onClick={() => updateFrame(current, { flipX: !doc.frames[current]?.flipX })} disabled={locked} title="H">水平翻转</button>
                  <span className="tool-sep" />
                  <span className="muted tool-label">调整顺序</span>
                  <button onClick={() => moveFrame(current, current - 1)} disabled={locked || current === 0} title="把选中的这一帧在播放顺序里往前挪一位（不会切换帧，也不会移动画面）">← 往前排</button>
                  <button onClick={() => moveFrame(current, current + 1)} disabled={locked || current >= doc.frames.length - 1} title="把选中的这一帧在播放顺序里往后挪一位（不会切换帧，也不会移动画面）">往后排 →</button>
                  <span className="spacer" />
                  {waitingJobs.length > 0 && !preview && (
                    <button className="primary" onClick={() => reviewNext()} title="按时间轴顺序逐个预览还没处理的 AI 候选">逐个看候选（{waitingJobs.length} 组）</button>
                  )}
                  <span className={problemFrames ? 'warn-text' : 'ok'}>{problemFrames ? `${problemFrames} 帧需要注意` : '没有发现问题'}</span>
                  <button onClick={nextProblem} disabled={!problemFrames}>下一个问题帧</button>
                  <span className="legend muted">格子宽度 = 显示时长 · 帧之间的竖条 = 画面变化量（红 = 跳变，蓝 = 几乎没变）</span>
                </div>
                <Timeline
                  action={shown}
                  current={current}
                  qc={qc}
                  urlOf={urlOf}
                  aiState={aiState}
                  previewId={PREVIEW_FRAME}
                  onInsertBetween={insertBetween}
                  onSelect={(i) => { setPlaying(false); setCurrent(i); }}
                  onMove={moveFrame}
                />
              </div>
            </>
          )}
        </main>
        <Inspector
          action={shown}
          index={index}
          qc={qc}
          versionUrl={(frame, version) => (frame.id === PREVIEW_FRAME ? urlOf(frame) : frameUrl(pid, doc.id, frame.id, version))}
          onUpdateAction={updateAction}
          onUpdateFrame={updateFrame}
          onSetAllDurations={setAllDurations}
          onAlign={align}
          onReplace={replaceImage}
          onDeleteAction={() => { void deleteAction(); }}
          aiPanel={selectedFrame && selectedFrame.id !== PREVIEW_FRAME && (
            <AiPanel
              key={selectedFrame.id}
              frame={selectedFrame}
              generatorLabel={generatorLabel}
              generatorProblem={generatorProblem}
              jobs={jobs.filter((job) => job.frame === selectedFrame.id)}
              mode={aiMode}
              onMode={(mode) => { setAiMode(mode); if (mode !== 'repair') setSelecting(false); }}
              nextLabel={nextLabel}
              keepTotal={keepTotal}
              onKeepTotal={setKeepTotal}
              gapCount={inbetweenGaps.length}
              onSubmitAll={(n) => { void submitAllInbetweens(n); }}
              rect={repairRect}
              selecting={selecting}
              onToggleSelect={() => { setPlaying(false); setSelecting((s) => !s); }}
              onClearRect={() => setRepairRect(null)}
              onSubmit={submitJob}
              preview={preview ? { jobId: preview.jobId, index: preview.index } : null}
              onPreview={previewCandidate}
              onAccept={(job, i) => { void acceptCandidate(job, i); }}
              onCancel={(job) => { void cancelJob(job); }}
              onReview={(job, reviewed) => { void reviewJob(job, reviewed); }}
              candidateSrc={(job, i) => candidateUrl(pid, job, i)}
            />
          )}
        />
      </div>

      {dialogs}
    </div>
  );
}

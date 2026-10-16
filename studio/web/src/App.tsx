import { ImageGenerationTest } from './shared/ImageGenerationTest';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { clock, importLyrics, uid, validate } from './lyrics';
import { drawScene, imageUrls } from './scene';
import type { Cue, ExportJob, Library, VideoDoc, RenderType, ArtJob, GeneratorSettings } from './types';

type Tab = 'theme' | 'scene' | 'character';
type Stage = 'scene' | 'lyrics' | 'export';
type Template = { name: string; style: Partial<VideoDoc> };
const DRAFT = 'lyric-studio-draft-v1', TEMPLATES = 'lyric-studio-templates-v1';
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
function readTemplates(): Template[] { try { return JSON.parse(localStorage.getItem(TEMPLATES) || '[]'); } catch { return []; } }

export default function App() {
  const [doc, setDoc] = useState<VideoDoc | null>(null), [lib, setLib] = useState<Library | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('');
  const [saved, setSaved] = useState(''), [tab, setTab] = useState<Tab>('theme'), [selected, setSelected] = useState('');
  const [t, setT] = useState(0), [playing, setPlaying] = useState(false), [imageRevision, setImageRevision] = useState(0);
  const [overflow, setOverflow] = useState(false), [lyricDialog, setLyricDialog] = useState(false), [lyricText, setLyricText] = useState('');
  const [job, setJob] = useState<ExportJob | null>(null), [templates, setTemplates] = useState<Template[]>(readTemplates);
  const [templateDialog, setTemplateDialog] = useState(false), [templateName, setTemplateName] = useState('');
  const [stage, setStage] = useState<Stage>('scene'), [inspector, setInspector] = useState<'type' | 'frame' | 'motion'>('type');
  const [typeData, setTypeData] = useState<RenderType | null>(null), [typeBusy, setTypeBusy] = useState(false);
  const [peaks, setPeaks] = useState<number[]>([]), [artJob, setArtJob] = useState<ArtJob | null>(null);
  const [artKind, setArtKind] = useState<'background' | 'panel'>('background'), [brief, setBrief] = useState('');
  const [settings, setSettings] = useState<GeneratorSettings | null>(null), [settingsOpen, setSettingsOpen] = useState(false);
  const [apiBase, setApiBase] = useState(''), [apiKey, setApiKey] = useState(''), [apiModel, setApiModel] = useState('');
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null), audio = useRef<HTMLAudioElement>(null);
  const loadedFonts = useRef(new Set<string>());
  const images = useRef(new Map<string, HTMLImageElement>()), docRef = useRef(doc), timeRef = useRef(t);
  docRef.current = doc; timeRef.current = t;
  const lastSaved = doc ? JSON.stringify(doc) : '';
  const dirty = !!doc && saved !== lastSaved;
  const exporting = job?.status === 'running' || job?.status === 'queued';

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.document(), api.library()]).then(([stored, library]) => {
      if (cancelled) return;
      setSaved(JSON.stringify(stored)); setLib(library);
      let initial = stored;
      try {
        const draft = JSON.parse(localStorage.getItem(DRAFT) || 'null');
        if (draft?.version === 1 && Array.isArray(draft.cues) && JSON.stringify(draft) !== JSON.stringify(stored)) {
          initial = { ...stored, ...draft }; setNotice('已恢复本机未保存的草稿。点击“保存项目”写入项目文件。');
        }
      } catch { /* An unreadable browser draft does not replace the saved project. */ }
      setDoc(initial); setSelected(initial.cues[0]?.id || '');
      setBrief(library.themes.find(t => t.id === initial.theme)?.brief || library.themes[0]?.brief || '');
      void api.settings().then(setSettings).catch(() => {});
      void api.templates().then(rows => { const names = new Set(rows.map(t => t.name)); setTemplates([...rows, ...readTemplates().filter(t => !names.has(t.name))]); }).catch(() => {});
    }).catch(e => { if (!cancelled) setError(errorText(e)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!doc) return;
    try { localStorage.setItem(DRAFT, JSON.stringify(doc)); } catch { setNotice('浏览器草稿空间不足，请点击“保存项目”。'); }
  }, [doc]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty || exporting) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, exporting]);

  const urls = doc && lib ? imageUrls(doc, lib).join('|') : '';
  useEffect(() => {
    let cancelled = false;
    Promise.all(urls.split('|').filter(Boolean).map(url => new Promise<void>((resolve, reject) => {
      if (images.current.has(url)) { resolve(); return; }
      const image = new Image(); image.onload = () => { images.current.set(url, image); resolve(); };
      image.onerror = () => reject(new Error('素材加载失败，请重新导入图片或检查本地服务。')); image.src = url;
    }))).then(() => { if (!cancelled) setImageRevision(x => x + 1); }).catch(e => { if (!cancelled) setError(errorText(e)); });
    return () => { cancelled = true; };
  }, [urls]);
  useEffect(() => { if (canvas.current && doc && lib) setOverflow(drawScene(canvas.current, doc, lib, images.current, t, typeData, !playing && stage === 'scene')); }, [doc, lib, t, imageRevision, typeData, playing, stage]);

  useEffect(() => {
    if (!playing) { audio.current?.pause(); return; }
    const element = audio.current;
    if (docRef.current?.audio && element) {
      element.currentTime = timeRef.current;
      void element.play().catch(() => { setPlaying(false); setError('歌曲无法播放，请检查音频格式或重新导入。'); });
    }
    const origin = performance.now(), initial = timeRef.current;
    let raf = 0;
    const tick = (now: number) => {
      const end = docRef.current?.duration || 0;
      const next = docRef.current?.audio && element ? element.currentTime : initial + (now - origin) / 1000;
      if (next >= end || (element?.ended && docRef.current?.audio)) { setT(end); setPlaying(false); return; }
      setT(next); raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); element?.pause(); };
  }, [playing]);

  useEffect(() => {
    if (!job || !exporting) return;
    let cancelled = false;
    const timer = window.setInterval(() => { api.job(job.id).then(j => { if (!cancelled) setJob(j); }).catch(e => { if (!cancelled) { setError(errorText(e)); setJob(null); } }); }, 800);
    return () => { cancelled = true; clearInterval(timer); };
  }, [job?.id, exporting]);
  useEffect(() => {
    if (!lyricDialog && !templateDialog && !settingsOpen) return;
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setLyricDialog(false); setTemplateDialog(false); setSettingsOpen(false); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [lyricDialog, templateDialog, settingsOpen]);

  const typeKey = doc ? JSON.stringify([doc.title, doc.cues.map(c => [c.id, c.text]), doc.fontId, doc.fontSize, doc.aspect, doc.letterSpacing, doc.lineHeight, doc.textAlign, doc.textColor, doc.highlightColor, doc.strokeColor, doc.textStroke, doc.textShadow, doc.textPadding, doc.dialogY, doc.dialogHeight, doc.accentColor]) : '';
  useEffect(() => {
    if (!docRef.current) return;
    let cancelled = false; setTypeBusy(true);
    const timer = window.setTimeout(() => {
      void api.typography(docRef.current!).then(async data => {
        const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
        const [image, titleImage] = await Promise.all([load(data.atlas), load(data.title)]);
        if (!cancelled) { setTypeData({ ...data, image, titleImage }); setTypeBusy(false); }
      }).catch(e => { if (!cancelled) { setError(errorText(e)); setTypeData(null); setTypeBusy(false); } });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [typeKey]);
  useEffect(() => {
    let cancelled = false; setPeaks([]);
    if (doc?.audio) void api.waveform(doc.audio).then(result => { if (!cancelled) setPeaks(result.peaks); }).catch(e => { if (!cancelled) setNotice('波形读取失败：' + errorText(e)); });
    return () => { cancelled = true; };
  }, [doc?.audio]);
  useEffect(() => {
    if (!artJob || !['running', 'queued'].includes(artJob.status)) return;
    let stopped = false;
    const timer = setInterval(() => { void api.artStatus(artJob.id).then(async job => { if (stopped) return; setArtJob(job); if (job.status === 'done') setLib(await api.library()); }).catch(e => { if (!stopped) { setError(errorText(e)); setArtJob(null); } }); }, 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [artJob?.id, artJob?.status]);
  useEffect(() => {
    const refresh = () => { void api.library().then(setLib).catch(() => {}); };
    window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh);
  }, []);

  useEffect(() => {
    for (const font of lib?.fonts || []) {
      if (font.family || loadedFonts.current.has(font.id)) continue;
      loadedFonts.current.add(font.id);
      const face = new FontFace('UserFont-' + font.id, `url("${font.url}")`);
      void face.load().then(loaded => document.fonts.add(loaded)).catch(() => loadedFonts.current.delete(font.id));
    }
  }, [lib]);

  const update = (change: Partial<VideoDoc>) => setDoc(current => current ? { ...current, ...change } : current);
  const seek = (value: number) => { setPlaying(false); const next = Math.max(0, Math.min(doc?.duration || 0, value)); setT(next); if (audio.current) audio.current.currentTime = next; };
  const choose = (cue: Cue) => { setSelected(cue.id); seek(cue.start); };
  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); setError(''); try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(''); } };
  const save = () => run('保存中', async () => { if (!doc) return; const message = validate(doc); if (message) throw new Error(message); await api.save(doc); setSaved(JSON.stringify(doc)); setNotice('项目已保存到本机。'); });
  const upload = (kind: 'audio' | 'background' | 'character' | 'font' | 'panel', file?: File) => {
    if (!file || !doc) return;
    setPlaying(false);
    void run('导入中', async () => {
      const result = await api.upload(kind, file);
      if (kind === 'audio') {
        const duration = result.duration!;
        setDoc(current => current ? { ...current, audio: result.id, audioName: file.name, duration,
          cues: current.cues.filter(c => c.start < duration).map(c => ({ ...c, end: Math.min(c.end, duration) })) } : current);
        setAudioDuration(duration); setT(0);
        setNotice('歌曲已导入。原有歌词时间保留，超出歌曲结尾的部分已裁切；请试听校准。');
      } else {
        setDoc(current => current ? { ...current, [kind === 'font' ? 'fontId' : kind === 'panel' ? 'panelImage' : kind]: result.id, ...(kind === 'character' ? { cues: current.cues.map(c => ({ ...c, action: '' })) } : {}) } : current);
        setNotice(result.warning || '素材已加入当前场景。');
        setLib(await api.library());
      }
    });
  };
  const applyLyrics = () => {
    if (!doc) return;
    try {
      const result = importLyrics(lyricText, doc.duration);
      const next = { ...doc, cues: result.cues }; const message = validate(next); if (message) throw new Error(message);
      update({ cues: result.cues }); setSelected(result.cues[0]?.id || ''); setLyricDialog(false); seek(0); setError('');
      setNotice(result.timed ? '已导入歌词时间戳，请试听检查。' : '已按总时长均分歌词。此为初始排布，需要试听校准，并非自动识别演唱时间。');
    } catch (e) { setError(errorText(e)); }
  };
  const cue = doc?.cues.find(c => c.id === selected);
  const patchCue = (patch: Partial<Cue>) => { if (doc && cue) update({ cues: doc.cues.map(c => c.id === cue.id ? { ...c, ...patch } : c) }); };
  const newCue = () => {
    if (!doc) return;
    let start = 0;
    for (const item of doc.cues) { if (item.start - start >= .2) break; start = item.end; }
    const nextStart = doc.cues.find(c => c.start >= start)?.start ?? doc.duration;
    const end = Math.min(start + 4, nextStart, doc.duration);
    if (end - start < .1) { setNotice('时间轴已排满，可用“拆成两句”拆分当前歌词，或先缩短现有歌词。'); return; }
    const item = { id: uid(), start, end, text: '写下这一句歌词', action: '' };
    update({ cues: [...doc.cues, item].sort((a, b) => a.start - b.start) }); choose(item);
  };
  const splitCue = () => {
    if (!doc || !cue) return;
    const middle = cue.start + (cue.end - cue.start) / 2, at = Math.ceil(cue.text.length / 2);
    const second = { ...cue, id: uid(), start: middle, text: cue.text.slice(at) };
    update({ cues: doc.cues.flatMap(c => c.id === cue.id ? [{ ...c, end: middle, text: c.text.slice(0, at) }, second] : [c]) });
    choose(second);
  };
  const startExport = () => run('准备导出', async () => {
    if (!doc) return;
    const message = validate(doc); if (message) throw new Error(message);
    setPlaying(false); await api.save(doc); setSaved(JSON.stringify(doc)); setJob(await api.export(doc));
  });

  const openSettings = () => { void api.settings().then(value => { setSettings(value); setApiBase(value.api.base); setApiModel(value.api.model); setApiKey(''); setSettingsOpen(true); }).catch(err => setNotice(String(err))); };
  if (!doc || !lib) return <div className="loading"><span className="wordmark">小言</span><h1>为每一首歌，造一个世界。</h1><p>{error || '正在准备你的创作空间…'}</p>{error && <button onClick={() => location.reload()}>重新载入</button>}</div>;
  const character = lib.characters.find(c => c.id === doc.character);
  const theme = lib.themes.find(item => item.id === doc.theme) ?? lib.themes[0];
  const problem = validate(doc);
  const active = doc.cues.find(c => c.start <= t && t < c.end);
  const artBusy = artJob && ['running', 'queued'].includes(artJob.status);
  const typeProblem = typeData?.missing.length ? `字体缺字：${typeData.missing.join('')}，请选择其他字体。` : typeData?.overflow.length ? `${typeData.overflow.length} 句歌词超出文字区域，请拆句、减小字号或增大对话框。` : '';
  const refreshLibrary = () => void run('刷新人物素材', async () => { setLib(await api.library()); setNotice('人物工坊的最新动作已同步。'); });

  const backgroundName = doc.background === 'builtin-room' ? '雨夜房间 · 构图草图' : lib.assets.find(a => a.id === doc.background)?.name || '自选背景';
  const saveTemplate = () => void run('保存模板', async () => {
    const { audio: _a, audioName: _n, cues: _c, title: _t, duration: _d, ...style } = doc;
    const item = await api.saveTemplate(templateName.trim(), style);
    const next = [...templates, item]; setTemplates(next);
    try { localStorage.setItem(TEMPLATES, JSON.stringify(next)); } catch { /* Disk copy is authoritative. */ }
    setTemplateDialog(false); setNotice('主题已保存到项目文件：场景、人物、字体、对话框和动效。');
  });

  return <div className={`atelier stage-${stage}`}>
    <header className="app-header">
      <a className="brand" href="/video/">视频工作台</a>
      <nav className="workflow" aria-label="创作流程">{(['scene', 'lyrics', 'export'] as Stage[]).map((item, i) => <button key={item} aria-current={stage === item ? 'step' : undefined} onClick={() => { setStage(item); setError(''); }}><span className="step-number">0{i + 1}</span>{['场景与风格', '歌词与演出', '预览与成片'][i]}</button>)}</nav>
      <div className="header-actions"><a href="/characters/" className="workshop-link">人物工坊 ↗</a><button className="icon-button" aria-label="生图设置" onClick={openSettings}>⚙</button><button disabled={!!busy} onClick={() => void save()}>{dirty ? '保存草稿' : '已保存'}<span className={dirty ? 'status-dot dirty' : 'status-dot'}/></button></div>
    </header>
    {(error || notice || busy) && <div className={`message ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}><span>{error || busy || notice}</span><button aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); }}>×</button></div>}
    <div className="project-bar"><div><span className="eyebrow">YOUR LITTLE WORLD / 作品</span><input className="project-name" aria-label="视频名称" value={doc.title} maxLength={60} onChange={e => update({ title: e.target.value })}/></div><div className="project-tools"><select aria-label="套用场景模板" defaultValue="" onChange={e => { const template = templates[Number(e.target.value)]; if (template) { update({ ...template.style, cues: doc.cues.map(c => ({ ...c, action: '' })) }); setNotice(`已套用“${template.name}”。`); } e.target.value = ''; }}><option value="" disabled>场景模板{templates.length ? ` · ${templates.length}` : ''}</option>{templates.map((item, i) => <option key={i} value={i}>{item.name}</option>)}</select><button onClick={() => { setTemplateName(doc.title + ' · 主题'); setTemplateDialog(true); }}>保存为模板</button></div></div>
    <div className="workspace">
      <aside className="left-panel">
        {stage === 'scene' && <>
          <div className="tabs" role="tablist" aria-label="场景素材">{(['theme', 'scene', 'character'] as Tab[]).map((item, i) => <button key={item} role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>{['主题', '场景', '人物'][i]}</button>)}</div>
          {tab === 'theme' && <><div className="panel-heading"><span className="eyebrow">01 / ART DIRECTION</span><h2>主题预设</h2><p>选择预设后可继续调整。</p></div><div className="theme-list">{lib.themes.map(item => <button key={item.id} className={`theme-card ${doc.theme === item.id ? 'selected' : ''}`} onClick={() => { update({ panelImage: '', ...item.settings, theme: item.id }); setBrief(item.brief); }}><div className={`theme-art ${item.id}`} style={{ color: item.settings.accentColor, backgroundColor: item.settings.panelColor }}>{item.settings.background && <img className="theme-art-image" src={'/media/' + item.settings.background} alt=""/>}<span className="theme-moon"/><span className="theme-line"/><span className="theme-sample" style={{ fontFamily: item.settings.fontId === 'fusion-pixel.ttf' ? 'StudioPixel' : 'StudioSerif' }}>晚风轻轻<br/>替我说想你</span><span className="theme-index">{item.tag}</span></div><div className="theme-caption"><strong>{item.name}</strong><span>{doc.theme === item.id ? '已选 ✓' : '试试看 ↗'}</span><p>{item.caption}</p></div></button>)}</div><p className="hint">主题联动字体、配色、边框和氛围。到“场景”生成与人物相配的美术。</p><button className="next-step" onClick={() => setTab('scene')}>去制作配套场景 →</button></>}
          {tab === 'scene' && <><div className="panel-heading"><span className="eyebrow">SCENE MAKER</span><h2>背景与对话框</h2><p>参考 {character?.name || '当前人物'} 的画风来创作。</p></div><div className="segmented"><button aria-pressed={artKind === 'background'} onClick={() => setArtKind('background')}>背景场景</button><button aria-pressed={artKind === 'panel'} onClick={() => setArtKind('panel')}>对话框美术</button></div><label>场景描述<textarea aria-label="场景描述" rows={5} value={brief} maxLength={2000} onChange={e => setBrief(e.target.value)} placeholder="雨夜的阁楼、温暖的台灯、窗外的城市…"/></label><div className="reference-note"><span className="reference-dot"/>人物画风 · 主题配色 · {artKind === 'background' ? '预留站位' : '留空文字区'}</div><button className="primary block" disabled={!!busy || !!artBusy || !brief.trim()} onClick={() => void run('准备场景生成', async () => { setArtJob(await api.art(doc, brief, artKind)); })}>{artBusy ? '正在绘制，请稍候…' : artKind === 'background' ? '✦ 生成配套背景' : '✦ 生成对话框素材'}</button><div className="generation-note"><span>{settings?.api.hasKey ? '使用已配置的图片服务额度' : '尚未配置图片服务'}</span><button className="text-button" onClick={openSettings}>生图设置</button></div>{artJob?.status === 'failed' && <p className="inline-warning" role="alert">{artJob.error}</p>}{artJob?.status === 'done' && artJob.asset && <div className="generated-choice"><img src={artJob.asset.url} alt="新生成的场景素材"/><button className="primary" onClick={() => { update(artJob.kind === 'background' ? { background: artJob.asset!.id } : { panelImage: artJob.asset!.id }); setNotice('新素材已应用到作品。'); }}>采用这张</button></div>}
          <div className="section-head"><h3>{artKind === 'background' ? '我的背景' : '我的对话框'}</h3><label className="inline-upload">导入图片<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!busy} onChange={e => { upload(artKind, e.target.files?.[0]); e.target.value = ''; }}/></label></div><div className="asset-grid">{artKind === 'background' && <button className={doc.background === 'builtin-room' ? 'selected' : ''} onClick={() => update({ background: 'builtin-room' })}><img src="/media/builtin-room.png" alt="构图草图"/><span>雨夜 · 构图草图</span></button>}{lib.assets.filter(a => a.kind === artKind).map(asset => <button key={asset.id} className={(artKind === 'background' ? doc.background : doc.panelImage) === asset.id ? 'selected' : ''} onClick={() => update(artKind === 'background' ? { background: asset.id } : { panelImage: asset.id })}><img src={asset.url} alt={asset.name}/><span>{asset.name}</span></button>)}</div>{artKind === 'panel' && <button className="text-button" onClick={() => update({ panelImage: '' })}>使用主题的可缩放边框</button>}</>}
          {tab === 'character' && <><div className="panel-heading"><span className="eyebrow">CASTING</span><h2>人物素材</h2><p>人物工坊制作，视频工作台演出。</p></div><div className="character-grid">{lib.characters.map(c => <button key={c.id} className={doc.character === c.id ? 'selected' : ''} onClick={() => update({ character: c.id, cues: doc.cues.map(item => ({ ...item, action: '' })) })}><img src={'/media/' + c.actions[0].frames[0]} alt=""/><strong>{c.name}</strong><small>{c.actions[0]?.id.endsWith(':reference') ? '静态立绘' : `${c.actions.length} 个动作`}</small></button>)}</div><a className="button block" href="/characters/">生成人物 / 制作动作 ↗</a><button className="text-button" onClick={refreshLibrary}>↻ 刷新人物工坊素材</button><label className="upload-button">＋ 导入透明人物图<input type="file" accept="image/png,image/webp" disabled={!!busy} onChange={e => { upload('character', e.target.files?.[0]); e.target.value = ''; }}/></label><label>人物大小 <output>{Math.round(doc.characterScale * 100)}%</output><input type="range" min={.15} max={.65} step={.01} value={doc.characterScale} onChange={e => update({ characterScale: Number(e.target.value) })}/></label><label>左右位置<input type="range" min={.05} max={.95} step={.01} value={doc.characterX} onChange={e => update({ characterX: Number(e.target.value) })}/></label><label>脚底位置<input type="range" min={.25} max={.79} step={.01} value={doc.characterY} onChange={e => update({ characterY: Number(e.target.value) })}/></label><button className="text-button muted" onClick={() => update({ character: '', cues: doc.cues.map(c => ({ ...c, action: '' })) })}>仅保留场景</button></>}
        </>}
        {stage === 'lyrics' && <><div className="panel-heading"><span className="eyebrow">02 / THE WORDS</span><h2>歌词编排</h2><p>点击歌词，安排它的时间与动作。</p></div><div className="section-head"><span>{doc.cues.length} 句</span><button className="text-button" onClick={() => { setLyricText(doc.cues.map(c => c.text).join('\n')); setLyricDialog(true); }}>导入 / 粘贴歌词</button></div><div className="cue-list">{doc.cues.map((item, i) => <button key={item.id} className={`cue-card ${item.id === selected ? 'selected' : ''} ${active?.id === item.id ? 'on-air' : ''}`} onClick={() => choose(item)}><span className="cue-meta"><span>{String(i + 1).padStart(2, '0')}</span><span>{clock(item.start)} — {clock(item.end)}</span></span><span className="cue-text">{item.text || '（空白歌词）'}</span><span className="cue-action">{character?.actions.find(a => a.id === item.action)?.label || '默认动作'}{active?.id === item.id ? ' · 当前播放' : ''}</span></button>)}</div><button className="add-cue" onClick={newCue}>＋ 添加一句</button></>}
        {stage === 'export' && <><div className="panel-heading"><span className="eyebrow">03 / A LITTLE FILM</span><h2>作品信息</h2><p>预览一遍，带走这个小世界。</p></div><dl className="film-facts"><div><dt>主题</dt><dd>{theme?.name || '自选主题'}</dd></div><div><dt>人物</dt><dd>{character?.name || (doc.character ? '自选人物' : '纯场景')}</dd></div><div><dt>字体</dt><dd>{lib.fonts.find(f => f.id === doc.fontId)?.name || '自选字体'}</dd></div><div><dt>时长</dt><dd>{clock(doc.duration)}</dd></div><div><dt>歌词</dt><dd>{doc.cues.length} 句</dd></div><div><dt>声音</dt><dd>{doc.audio ? doc.audioName : '静音视频'}</dd></div></dl><button className="button block" onClick={() => { seek(0); setPlaying(true); }}>从头完整预览</button><p className="hint">导出时使用当前作品的快照。字体和排版与画面预览共用同一份字形。</p></>}
      </aside>
      <main className="preview-panel"><div className="preview-toolbar"><span><span className="live-dot"/>{playing ? '正在演出' : stage === 'scene' ? '构图预览 · 暂停时展示完整歌词' : '成片预览'}</span><div className="segmented"><button aria-pressed={doc.aspect === 'portrait'} onClick={() => update({ aspect: 'portrait' })}>9:16</button><button aria-pressed={doc.aspect === 'landscape'} onClick={() => update({ aspect: 'landscape' })}>16:9</button></div></div><div className={`preview-stage ${doc.aspect}`}><canvas ref={canvas} aria-label="作品预览：背景、人物、字体与歌词"/></div><div className="preview-caption"><span>{backgroundName}</span><span>{doc.aspect === 'portrait' ? '720 × 1280' : '1280 × 720'} · {lib.fps} FPS</span></div>{(typeBusy || overflow || typeProblem) && <p className={typeProblem || overflow ? 'inline-warning' : 'hint'}>{typeBusy ? '正在排版…' : typeProblem || '当前歌词超出文字区域。'}</p>}<div className="playback"><button aria-label="回到开头" onClick={() => seek(0)}>↤</button><button className="play-button" disabled={!!busy || typeBusy} onClick={() => { if (t >= doc.duration) { setT(0); timeRef.current = 0; } setPlaying(p => !p); }}>{playing ? 'Ⅱ 暂停' : '▶ 播放'}</button><output>{clock(t)}<span> / {clock(doc.duration)}</span></output></div><input className="preview-seek" aria-label="播放位置" type="range" min={0} max={doc.duration || 1} step={.01} value={t} onChange={e => seek(Number(e.target.value))}/><span className="preview-poem">{stage === 'scene' ? '让每一种颜色、每一个字，都属于同一个故事。' : stage === 'lyrics' ? '停顿、呼吸、下一句。' : '一首歌，一个可以停留的小世界。'}</span></main>
      <aside className="right-panel">
        {stage === 'scene' && <><div className="tabs inspector-tabs" role="tablist" aria-label="风格细节">{(['type', 'frame', 'motion'] as const).map((item, i) => <button role="tab" aria-selected={inspector === item} key={item} onClick={() => setInspector(item)}>{['字体', '对话框', '氛围'][i]}</button>)}</div>
        {inspector === 'type' && <section><span className="eyebrow">TYPOGRAPHY</span><h2>字体与排版</h2><div className="font-list">{lib.fonts.map(f => <button key={f.id} className={doc.fontId === f.id ? 'selected' : ''} onClick={() => update({ fontId: f.id })}><span className="font-name">{f.name}{doc.fontId === f.id ? ' ✓' : ''}</span><span className="font-sample" style={{ fontFamily: f.family || 'UserFont-' + f.id }}>晚风轻轻，雨声淅沥</span><small>{f.label || '自选字体'}</small></button>)}</div><label className="inline-upload">＋ 导入字体 TTF / OTF<input type="file" accept=".ttf,.otf" disabled={!!busy} onChange={e => { upload('font', e.target.files?.[0]); e.target.value = ''; }}/></label><label>字号 <output>{doc.fontSize}</output><input type="range" min={20} max={48} value={doc.fontSize} onChange={e => update({ fontSize: Number(e.target.value) })}/></label><div className="two-columns"><label>字距<input type="number" min={-1} max={8} step={.5} value={doc.letterSpacing} onChange={e => update({ letterSpacing: Number(e.target.value) })}/></label><label>行距<input type="number" min={1.1} max={2.2} step={.1} value={doc.lineHeight} onChange={e => update({ lineHeight: Number(e.target.value) })}/></label></div><label>对齐<select value={doc.textAlign} onChange={e => update({ textAlign: e.target.value as VideoDoc['textAlign'] })}><option value="left">靠左 · 对话感</option><option value="center">居中 · 诗句感</option><option value="right">靠右</option></select></label><div className="color-row"><label>文字<input type="color" value={doc.textColor} onChange={e => update({ textColor: e.target.value })}/></label><label>高亮<input type="color" value={doc.highlightColor} onChange={e => update({ highlightColor: e.target.value })}/></label><label>描边<input type="color" value={doc.strokeColor} onChange={e => update({ strokeColor: e.target.value })}/></label></div><label>描边粗细 <output>{doc.textStroke}px</output><input type="range" min={0} max={3} value={doc.textStroke} onChange={e => update({ textStroke: Number(e.target.value) })}/></label><label className="check-row"><input type="checkbox" checked={doc.textShadow} onChange={e => update({ textShadow: e.target.checked })}/>轻微文字投影</label><p className="hint">同一份字形用于预览与成片。缺字、超框会在导出前提示。</p></section>}
        {inspector === 'frame' && <section><span className="eyebrow">DIALOGUE DESIGN</span><h2>对话框设置</h2><label>边框语言<select value={doc.skin} onChange={e => update({ skin: e.target.value as VideoDoc['skin'], panelImage: '' })}><option value="ornate">细金边 · 书信</option><option value="pixel">像素双线 · 游戏</option><option value="paper">留白细框 · 手记</option><option value="cream">经典双框</option><option value="night">夜色双框</option></select></label><div className="color-row"><label>底色<input type="color" value={doc.panelColor} onChange={e => update({ panelColor: e.target.value })}/></label><label>边框<input type="color" value={doc.accentColor} onChange={e => update({ accentColor: e.target.value })}/></label></div><label>框内留白 <output>{doc.textPadding}px</output><input type="range" min={18} max={70} value={doc.textPadding} onChange={e => update({ textPadding: Number(e.target.value) })}/></label><label>对话框高度<input type="range" min={.12} max={Math.min(.30, .99 - doc.dialogY)} step={.01} value={doc.dialogHeight} onChange={e => update({ dialogHeight: Number(e.target.value) })}/></label><label>上下位置<input type="range" min={.60} max={Math.min(.84, .99 - doc.dialogHeight)} step={.01} value={doc.dialogY} onChange={e => update({ dialogY: Number(e.target.value) })}/></label><button className="block" onClick={() => { setTab('scene'); setArtKind('panel'); }}>生成与人物配套的边框 ↗</button><label className="upload-button">导入自己的对话框素材<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!busy} onChange={e => { upload('panel', e.target.files?.[0]); e.target.value = ''; }}/></label>{doc.panelImage && <button className="text-button" onClick={() => update({ panelImage: '' })}>移除自选素材，恢复主题边框</button>}<p className="hint">边框素材用九宫格方式缩放，歌词单独排版，不会画死在图片里。</p></section>}
        {inspector === 'motion' && <section><span className="eyebrow">ATMOSPHERE</span><h2>背景动效</h2><label>环境动效<select value={doc.atmosphere} onChange={e => update({ atmosphere: e.target.value as VideoDoc['atmosphere'] })}><option value="rain">窗前细雨</option><option value="snow">慢慢落雪</option><option value="fireflies">点点萤火</option><option value="dust">光里的微尘</option><option value="none">安静 · 无粒子</option></select></label><label>氛围浓度<input type="range" min={0} max={1} step={.05} value={doc.motionAmount} onChange={e => update({ motionAmount: Number(e.target.value) })}/></label><label className="check-row"><input type="checkbox" checked={doc.cameraMotion} onChange={e => update({ cameraMotion: e.target.checked })}/>镜头轻轻游移</label><label className="check-row"><input type="checkbox" checked={doc.lightPulse} onChange={e => update({ lightPulse: e.target.checked })}/>暖光缓慢呼吸</label><div className="motion-note"><span>8 秒</span><p>镜头与暖光循环<br/>人物、歌词始终独立</p></div><button className="block" onClick={() => setPlaying(p => !p)}>{playing ? '暂停氛围预览' : '播放，感受一下'}</button><p className="hint">背景图保持原画，通过轻微运镜、光效和粒子产生动态。这里不会把人物和歌词一起变形。</p></section>}
        </>}
        {stage === 'lyrics' && <section><span className="eyebrow">PERFORMANCE / {cue ? String(doc.cues.indexOf(cue) + 1).padStart(2, '0') : '—'}</span><h2>当前歌词</h2>{cue ? <><label>歌词文字<textarea aria-label="当前歌词文字" maxLength={160} rows={4} value={cue.text} onChange={e => patchCue({ text: e.target.value })}/></label><div className="two-columns"><label>开始 / 秒<input type="number" min={0} step={.1} value={Number(cue.start.toFixed(2))} onChange={e => patchCue({ start: Number(e.target.value) })}/></label><label>结束 / 秒<input type="number" min={0} step={.1} value={Number(cue.end.toFixed(2))} onChange={e => patchCue({ end: Number(e.target.value) })}/></label></div><div className="two-columns"><button className="small-button" onClick={() => patchCue({ start: Number(t.toFixed(2)) })}>此刻开始</button><button className="small-button" onClick={() => patchCue({ end: Number(t.toFixed(2)) })}>此刻结束</button></div><label>人物动作<select value={cue.action} onChange={e => patchCue({ action: e.target.value })}><option value="">默认循环</option>{character?.actions.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label><label>歌词出现方式<select value={doc.reveal} onChange={e => update({ reveal: e.target.value as VideoDoc['reveal'] })}><option value="type">逐字浮现</option><option value="line">整句出现</option><option value="highlight">逐字高亮</option></select></label><p className="hint">逐字效果在每句时间内匀速分配。拖动播放位置试听，再用“此刻开始 / 结束”打点。</p><div className="two-columns"><button onClick={splitCue}>拆成两句</button><button className="danger-text" onClick={() => { const remaining = doc.cues.filter(c => c.id !== cue.id); update({ cues: remaining }); setSelected(remaining[0]?.id || ''); }}>删除此句</button></div></> : <p className="muted">导入歌词，开始编排。</p>}<button className="next-step" onClick={() => setStage('export')}>去预览整首作品 →</button></section>}
        {stage === 'export' && <section><span className="eyebrow">TAKE IT WITH YOU</span><h2>导出设置</h2><label>画幅<select value={doc.aspect} onChange={e => update({ aspect: e.target.value as VideoDoc['aspect'] })}><option value="portrait">竖屏 9:16 · 720 × 1280</option><option value="landscape">横屏 16:9 · 1280 × 720</option></select></label><label>视频时长 / 秒<input type="number" min={.2} max={audioDuration ?? 600} step={.1} value={Number(doc.duration.toFixed(2))} onChange={e => { setPlaying(false); update({ duration: Number(e.target.value) }); setT(0); }}/></label><div className="export-spec"><span>MP4</span><p>24 FPS · H.264<br/>{doc.audio ? '包含歌曲 · AAC 音轨' : '未导入歌曲 · 静音成片'}</p></div>{(problem || typeProblem) && <p className="inline-warning" role="alert">{problem || typeProblem}</p>}<button className="primary block large-button" disabled={!!busy || exporting || !lib.canExport || !!problem || !!typeProblem || typeBusy} onClick={() => void startExport()}>{exporting ? `正在导出 ${job?.progress}%` : '↗ 导出作品'}</button>{!lib.canExport && <p className="inline-warning">需要安装 FFmpeg 才能导出视频。</p>}<p className="hint">文件保存在本机。导出过程中可以继续修改作品，不影响已经提交的版本。</p></section>}
      </aside>
    </div>
    {stage === 'lyrics' && <section className="timeline-panel"><div className="timeline-head"><strong>音乐与歌词时间轴</strong><span>{doc.audio ? doc.audioName : '先放入一首歌'}</span><label className="inline-upload">{doc.audio ? '更换歌曲' : '＋ 导入歌曲'}<input type="file" accept=".mp3,.wav,.m4a,.ogg,.flac,.aac,.webm" disabled={!!busy} onChange={e => { upload('audio', e.target.files?.[0]); e.target.value = ''; }}/></label>{doc.audio && <button className="text-button" onClick={() => { setPlaying(false); update({ audio: '', audioName: '' }); setAudioDuration(null); }}>移除</button>}</div><div className="ruler-labels"><span>00:00</span><span>{clock(doc.duration / 2)}</span><span>{clock(doc.duration)}</span></div><div className="waveform" role="img" aria-label={peaks.length ? '歌曲的真实音频波形' : '尚未导入歌曲'}>{peaks.length ? <svg viewBox="0 0 1000 60" preserveAspectRatio="none" aria-hidden="true">{peaks.map((peak, i) => <line key={i} x1={i / peaks.length * 1000} x2={i / peaks.length * 1000} y1={30 - peak * 28} y2={30 + peak * 28}/>)}</svg> : <span>歌曲导入后，这里会显示真实波形</span>}<input aria-label="波形播放位置" type="range" min={0} max={doc.duration || 1} step={.01} value={t} onChange={e => seek(Number(e.target.value))}/><div className="wave-playhead" style={{ left: `${t / Math.max(.2, doc.duration) * 100}%` }}/></div><div className="cue-track">{doc.cues.map((item, i) => <button key={item.id} aria-label={`定位第 ${i + 1} 句：${item.text}`} title={`${clock(item.start)} ${item.text}`} className={item.id === selected ? 'selected' : ''} style={{ left: `${item.start / Math.max(.2, doc.duration) * 100}%`, width: `${Math.max(0, item.end - item.start) / Math.max(.2, doc.duration) * 100}%` }} onClick={() => choose(item)}>{String(i + 1).padStart(2, '0')} · {item.text}</button>)}</div>{problem && <p className="inline-warning" role="alert">{problem}</p>}</section>}
    {stage === 'scene' && <div className="chapter-end"><span>让场景、字体与光，说同一种语言。</span><button onClick={() => { setStage('lyrics'); seek(0); }}>歌词编排 →</button></div>}
    {job && <section className="export-status" aria-live="polite"><div><strong>{job.status === 'done' ? '视频已导出' : job.status === 'failed' ? '导出失败' : job.status === 'cancelled' ? '已取消导出' : '正在导出视频…'}</strong><span>{job.error || `${job.progress}%`}</span></div>{exporting && <><progress max={100} value={job.progress}/><button onClick={() => void api.cancel(job.id).catch(e => setError(errorText(e)))}>取消导出</button></>}{job.url && <a className="button primary" href={job.url} download={`${doc.title}.mp4`}>下载 MP4</a>}<button disabled={exporting} onClick={() => setJob(null)}>关闭</button></section>}
    <footer><span>小言 · 一个属于歌曲的创作空间</span><span>项目与素材保存在本机</span><a href="/characters/">人物工坊 ↗</a></footer>
    <audio ref={audio} src={doc.audio ? '/media/' + doc.audio : undefined} preload="metadata" onLoadedMetadata={() => setAudioDuration(audio.current?.duration ?? null)} onEnded={() => { setPlaying(false); setT(doc.duration); }}/>
    {lyricDialog && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="lyric-title"><div className="section-head"><h2 id="lyric-title">导入歌词</h2><button aria-label="关闭歌词导入" onClick={() => setLyricDialog(false)}>×</button></div><p>每行一句，或粘贴带时间戳的 LRC。导入将替换当前歌词。</p><label className="upload-button">读取 TXT / LRC 文件<input type="file" accept=".txt,.lrc" onChange={e => { const file = e.target.files?.[0]; if (file) void file.text().then(setLyricText).catch(err => setError(errorText(err))); }}/></label><textarea autoFocus aria-label="待导入歌词" rows={10} value={lyricText} onChange={e => setLyricText(e.target.value)}/><p className="hint">普通文本先均分时长，再试听校准，不会自动识别演唱时间。</p><div className="modal-actions"><button onClick={() => setLyricDialog(false)}>取消</button><button className="primary" onClick={applyLyrics}>替换为这些歌词</button></div></section></div>}
    {templateDialog && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="template-title"><span className="eyebrow">SAVE YOUR WORLD</span><h2 id="template-title">保存场景模板</h2><p>保留人物、场景、字体、对话框与氛围。下一首歌，继续这个世界。</p><label>主题名称<input autoFocus maxLength={60} value={templateName} onChange={e => setTemplateName(e.target.value)}/></label><div className="modal-actions"><button onClick={() => setTemplateDialog(false)}>取消</button><button className="primary" disabled={!templateName.trim()} onClick={saveTemplate}>保存模板</button></div></section></div>}
    {settingsOpen && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="section-head"><h2 id="settings-title">生图设置</h2><button aria-label="关闭生图设置" onClick={() => setSettingsOpen(false)}>×</button></div><p>场景与人物工坊共用图片 API 配置。密钥仅保存在本机，不会回传到页面。</p><label>服务地址<input autoFocus placeholder="https://…/v1" value={apiBase} onChange={e => setApiBase(e.target.value)}/></label><label>API 密钥<input type="password" autoComplete="off" value={apiKey} placeholder={settings?.api.hasKey ? '已保存，留空保留' : '请填写图片服务密钥'} onChange={e => setApiKey(e.target.value)}/></label><label>图片模型<input value={apiModel} placeholder="图片服务提供的模型名称" onChange={e => setApiModel(e.target.value)}/></label><ImageGenerationTest save={async () => { setSettings(await api.saveSettings({ provider: 'api', api: { base: apiBase, model: apiModel, ...(apiKey ? { key: apiKey } : {}) } })); }} /><div className="modal-actions"><button onClick={() => setSettingsOpen(false)}>取消</button><button className="primary" disabled={!!busy || !apiBase.trim() || !apiModel.trim()} onClick={() => void run('保存生图设置', async () => { setSettings(await api.saveSettings({ provider: 'api', api: { base: apiBase, model: apiModel, ...(apiKey ? { key: apiKey } : {}) } })); setSettingsOpen(false); setApiKey(''); setNotice('场景与人物工坊的图片服务已更新。'); })}>保存设置</button></div></section></div>}
  </div>;
}

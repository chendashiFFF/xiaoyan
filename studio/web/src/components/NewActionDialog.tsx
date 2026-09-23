import { useEffect, useState } from 'react';
import type { ActionSuggestion, Facing, KeyposeRequest, NewActionRequest, Playback } from '../types';

interface Props {
  existingIds: string[];
  onClose: () => void;
  onCreate: (action: NewActionRequest, keyposes: KeyposeRequest) => Promise<void>;
  /** Suggestions already fetched for this character (kept between openings). */
  suggestions: ActionSuggestion[] | null;
  onSuggest: (idea: string) => Promise<ActionSuggestion[]>;
}

const FACING_LABEL: Record<Facing, string> = { front: '正面', right: '朝右', left: '朝左' };

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function NewActionDialog({ existingIds, onClose, onCreate, suggestions, onSuggest }: Props) {
  const [label, setLabel] = useState('');
  const [id, setId] = useState('');
  const [description, setDescription] = useState('');
  const [keyframes, setKeyframes] = useState(4);
  const [facing, setFacing] = useState<Facing>('front');
  const [grounded, setGrounded] = useState(true);
  const [playback, setPlayback] = useState<Playback>('loop');
  const [duration, setDuration] = useState(150);
  const [cellSize, setCellSize] = useState(512);
  const [candidates, setCandidates] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idea, setIdea] = useState('');
  const [thinking, setThinking] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const suggest = async (text: string) => {
    setThinking(true);
    setSuggestError(null);
    try {
      await onSuggest(text);
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : String(err));
    } finally {
      setThinking(false);
    }
  };
  // First opening for this character: ask for ideas straight away, since writing them by hand is the hard part.
  useEffect(() => {
    if (!suggestions) void suggest('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (s: ActionSuggestion) => {
    setPicked(s.id);
    setLabel(s.label);
    setId(s.id);
    setDescription(s.description);
    setKeyframes(s.keyframes);
    setFacing(s.facing);
    setGrounded(s.grounded);
    setPlayback(s.playback);
    setDuration([80, 100, 120, 150, 200, 250].reduce((best, ms) => (Math.abs(ms - s.duration) < Math.abs(best - s.duration) ? ms : best), 150));
  };

  const idError = !id ? '填一个英文 ID' : !SLUG.test(id) ? '只能用小写字母、数字、- 和 _' : existingIds.includes(id) ? '这个 ID 已经有了' : null;
  const ready = !idError && label.trim() && description.trim();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCreate(
        { id, label: label.trim(), cellSize, grounded, playback },
        { instruction: description.trim(), keyframes, facing, candidates, duration },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="新建动作">
        <header>
          <h2>新建动作</h2>
          <button className="ghost" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <div className="modal-form">
          <section className="suggest">
            <div className="suggest-head">
              <h3>AI 推荐动作</h3>
              <button className="ghost small-btn" disabled={thinking} onClick={() => void suggest(idea)}>换一批</button>
            </div>
            <div className="row">
              <input
                className="grow"
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && idea.trim()) void suggest(idea); }}
                placeholder="有想法就写一句（可选）：比如 打招呼、吃东西、生气"
              />
              <button disabled={thinking || !idea.trim()} onClick={() => void suggest(idea)}>按这个想法推荐</button>
            </div>
            {thinking && <p className="muted thinking"><span className="spinner" />AI 正在构思，大约半分钟…</p>}
            {suggestError && <p className="error">{suggestError}</p>}
            {suggestions && suggestions.length > 0 && (
              <div className="suggest-grid">
                {suggestions.map((s) => {
                  const taken = existingIds.includes(s.id);
                  return (
                    <button key={s.id} className={`suggest-card ${picked === s.id ? 'active' : ''}`} onClick={() => pick(s)} disabled={thinking}>
                      <strong>{s.label}<small>{s.id}{taken ? '（已存在）' : ''}</small></strong>
                      <span className="suggest-desc">{s.description}</span>
                      <span className="suggest-meta">
                        {s.keyframes} 个姿势 · {FACING_LABEL[s.facing]} · {s.playback === 'loop' ? '循环' : '往返'} · {s.duration}ms{s.grounded ? '' : ' · 离地'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="muted hint">点一个方案会填到下面，还可以再改。确认后 AI 按描述画关键姿势，再用"补中间帧"补顺。</p>
          </section>
          <div className="grid-2">
            <label className="field">
              <span>名称</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="吃冰淇淋" autoFocus />
            </label>
            <label className="field">
              <span>ID（文件夹名）</span>
              <input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="eat-icecream" />
              {id && idError && <small className="error">{idError}</small>}
            </label>
          </div>
          <label className="field">
            <span>动作描述（写清楚动作过程，AI 会照着画关键姿势）</span>
            <textarea
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="开心地吃甜筒：拿起甜筒、舔一口、眯眼笑、再把甜筒举起来"
            />
          </label>
          <div className="grid-3">
            <label className="field">
              <span>关键姿势</span>
              <select value={keyframes} onChange={(e) => setKeyframes(Number(e.target.value))}>
                <option value={4}>4 个（2×2）</option>
                <option value={6}>6 个（2×3）</option>
              </select>
            </label>
            <label className="field">
              <span>朝向</span>
              <select value={facing} onChange={(e) => setFacing(e.target.value as Facing)}>
                <option value="front">正面</option>
                <option value="right">朝右（侧身）</option>
                <option value="left">朝左（侧身）</option>
              </select>
            </label>
            <label className="field">
              <span>播放方式</span>
              <select value={playback} onChange={(e) => setPlayback(e.target.value as Playback)}>
                <option value="loop">循环</option>
                <option value="pingpong">往返</option>
              </select>
            </label>
            <label className="field">
              <span>每帧时长</span>
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {[80, 100, 120, 150, 200, 250].map((ms) => <option key={ms} value={ms}>{ms}ms</option>)}
              </select>
            </label>
            <label className="field">
              <span>帧尺寸</span>
              <select value={cellSize} onChange={(e) => setCellSize(Number(e.target.value))}>
                <option value={512}>512（推荐）</option>
                <option value={256}>256（和现有动作一样）</option>
              </select>
            </label>
            <label className="field">
              <span>候选</span>
              <select value={candidates} onChange={(e) => setCandidates(Number(e.target.value))}>
                {[1, 2, 3].map((n) => <option key={n} value={n}>{n} 组</option>)}
              </select>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={grounded} onChange={(e) => setGrounded(e.target.checked)} />
            <span>脚踩地面（跳跃、飞行这类动作取消勾选）</span>
          </label>
          {error && <p className="error">{error}</p>}
          <div className="row end">
            <span className="muted hint">每组约 1–2 分钟，消耗生图额度</span>
            <button onClick={onClose}>取消</button>
            <button className="primary" disabled={!ready || busy} onClick={submit}>{busy ? '创建中…' : '创建并生成关键姿势'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

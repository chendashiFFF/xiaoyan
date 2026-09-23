import { useEffect, useRef, useState } from 'react';
import type { ProjectSummary } from '../types';

interface Props {
  projects: ProjectSummary[];
  current: string;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onReferences: () => void;
  onDelete: () => void;
}

export function CharacterMenu({ projects, current, onSwitch, onCreate, onReferences, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = projects.find((p) => p.id === current);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="character-menu" ref={ref}>
      <button className="character-button" onClick={() => setOpen((o) => !o)} title="切换人物">
        <span className="avatar checker">{active?.thumb && <img src={active.thumb} alt="" />}</span>
        <span>{active?.name ?? current}</span>
        <span className="muted">▾</span>
      </button>
      <button className="ghost small-btn" onClick={onReferences} title="查看和更换这个人物的参考图">角色参考</button>
      {open && (
        <div className="character-dropdown">
          {projects.map((p) => (
            <button
              key={p.id}
              className={p.id === current ? 'active' : ''}
              onClick={() => { setOpen(false); if (p.id !== current) onSwitch(p.id); }}
            >
              <span className="avatar checker">{p.thumb && <img src={p.thumb} alt="" />}</span>
              <span className="name">{p.name}<small>{p.id} · {p.actionCount} 个动作</small></span>
            </button>
          ))}
          <button className="new" onClick={() => { setOpen(false); onCreate(); }}>＋ 新人物</button>
          <button
            className="delete"
            disabled={projects.length <= 1}
            title={projects.length <= 1 ? '至少要保留一个人物' : '删除当前人物（移到回收目录，可以找回）'}
            onClick={() => { setOpen(false); onDelete(); }}
          >
            删除「{active?.name ?? current}」…
          </button>
        </div>
      )}
    </div>
  );
}

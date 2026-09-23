import type { ActionSummary } from '../types';

interface Props {
  actions: ActionSummary[];
  warnings: Record<string, number | undefined>;
  current: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

export function ActionList({ actions, warnings, current, onSelect, onCreate }: Props) {
  return (
    <nav className="action-list">
      <div className="list-head">
        <h3>动作</h3>
        <button className="ghost small-btn" onClick={onCreate} title="用 AI 生成一个新动作">＋ 新动作</button>
      </div>
      <ul>
        {actions.map((action) => {
          const warn = warnings[action.id];
          return (
            <li key={action.id}>
              <button className={action.id === current ? 'active' : ''} onClick={() => onSelect(action.id)}>
                <span className="thumb checker">{action.thumb && <img src={action.thumb} alt="" />}</span>
                <span className="name">
                  {action.label}
                  <small>{action.id} · {action.frameCount ? `${action.frameCount} 帧` : '还没有帧'}</small>
                </span>
                {warn === undefined ? null : warn > 0 ? <span className="badge warn">⚠ {warn}</span> : <span className="badge ok">✓</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

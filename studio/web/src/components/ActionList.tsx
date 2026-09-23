import type { ActionSummary } from '../types';

interface Props {
  actions: ActionSummary[];
  warnings: Record<string, number | undefined>;
  current: string | null;
  onSelect: (id: string) => void;
}

export function ActionList({ actions, warnings, current, onSelect }: Props) {
  return (
    <nav className="action-list">
      <h3>动作</h3>
      <ul>
        {actions.map((action) => {
          const warn = warnings[action.id];
          return (
            <li key={action.id}>
              <button className={action.id === current ? 'active' : ''} onClick={() => onSelect(action.id)}>
                <span className="thumb checker">{action.thumb && <img src={action.thumb} alt="" />}</span>
                <span className="name">
                  {action.label}
                  <small>{action.id} · {action.frameCount} 帧</small>
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

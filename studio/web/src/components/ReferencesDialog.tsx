import { useRef, useState } from 'react';
import type { Project, ProjectSummary, ReferenceRole } from '../types';
import { ReferenceGenerator } from './ReferenceGenerator';

interface Props {
  project: Project;
  fileUrl: (rel: string) => string;
  onClose: () => void;
  onUpload: (file: File, role: ReferenceRole) => Promise<string | null>;
  onAssign: (role: ReferenceRole, rel: string | null) => Promise<void>;
  projects: ProjectSummary[];
  initialSources?: string[];
  onUploadSource: (file: File) => Promise<string>;
  onProjectChange: (project: Project) => void;
}

const ROLES: { role: ReferenceRole; key: 'identityReference' | 'designReference'; title: string; usage: string; tip: string }[] = [
  {
    role: 'identity',
    key: 'identityReference',
    title: '主参考图',
    usage: 'AI 每次生成都会带上它，用来认人；新建动作时也按它的身高和脚底位置统一每个姿势的大小。',
    tip: '最好是正面、站直、全身、透明背景（纯品红底也行，会自动抠掉）。',
  },
  {
    role: 'design',
    key: 'designReference',
    title: '设定图（可选）',
    usage: '有正面、侧面、背面和细节特写的设定图。AI 画侧身、背身或细节时会参考它。',
    tip: '三视图最有用；背景和文字没关系，AI 会忽略。',
  },
];

export function ReferencesDialog({ project, fileUrl, onClose, onUpload, onAssign, projects, initialSources, onUploadSource, onProjectChange }: Props) {
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal refs-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="角色参考">
        <header>
          <h2>「{project.name}」的角色参考</h2>
          <button className="ghost" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <div className="refs-body">
          {ROLES.map(({ role, key, title, usage, tip }) => {
            const current = project[key] ?? null;
            const others = project.references.filter((r) => r !== current);
            return (
              <section key={role} className="ref-card">
                <h3>{title}</h3>
                <div className="ref-preview checker">
                  {current ? <img src={fileUrl(current)} alt={title} /> : <span className="muted">还没有设置</span>}
                </div>
                {current && <code className="muted">{current}</code>}
                <p className="hint">{usage}</p>
                <p className="hint muted">{tip}</p>
                <input
                  ref={(el) => { inputs.current[role] = el; }}
                  type="file"
                  accept="image/png,image/webp,image/jpeg"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void run(role, async () => setWarning(await onUpload(file, role)));
                  }}
                />
                <div className="row">
                  <button className="primary" disabled={busy !== null} onClick={() => inputs.current[role]?.click()}>
                    {busy === role ? '上传中…' : current ? '换一张' : '上传'}
                  </button>
                  {role === 'design' && current && (
                    <button disabled={busy !== null} onClick={() => void run(role, () => onAssign(role, null))}>不使用设定图</button>
                  )}
                </div>
                {others.length > 0 && (
                  <>
                    <p className="hint muted">或者从这个人物已有的图里选：</p>
                    <div className="ref-others">
                      {others.map((rel) => (
                        <button key={rel} className="checker" disabled={busy !== null} title={rel} onClick={() => void run(role, () => onAssign(role, rel))}>
                          <img src={fileUrl(rel)} alt="" />
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </section>
            );
          })}
        </div>
        {(warning || error) && <p className={`refs-message ${error ? 'error' : 'warn-text'}`}>{error ?? warning}</p>}
        <ReferenceGenerator
          project={project}
          projects={projects}
          fileUrl={fileUrl}
          initialSources={initialSources}
          onUploadSource={onUploadSource}
          onProjectChange={onProjectChange}
        />
      </div>
    </div>
  );
}

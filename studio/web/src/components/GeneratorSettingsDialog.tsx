import { useState } from 'react';
import { api } from '../api';
import type { GeneratorSettings, Provider } from '../types';

interface Props {
  settings: GeneratorSettings;
  onClose: () => void;
  onSaved: (settings: GeneratorSettings) => void;
}

const MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
const QUALITIES: { value: string; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '更高（xhigh）' },
  { value: 'max', label: '最高（max）' },
];

export function GeneratorSettingsDialog({ settings, onClose, onSaved }: Props) {
  const [provider, setProvider] = useState<Provider>(settings.provider);
  const [base, setBase] = useState(settings.api.base);
  const [key, setKey] = useState('');
  const [model, setModel] = useState(settings.api.model);
  const [quality, setQuality] = useState(settings.api.quality);
  const [timeout, setTimeoutSeconds] = useState(settings.api.timeout);
  const [models, setModels] = useState<string[]>([]);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiPatch = () => ({ base, model, quality, timeout, ...(key ? { key } : {}) });

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const result = await api.testSettings(apiPatch());
      setModels(result.models);
      setTest(result.ok
        ? { ok: true, text: result.hasModel ? `连接成功，模型 ${model} 可用` : `连接成功，但列表里没有 ${model}。可用的图片模型：${result.models.join('、') || '（没有）'}` }
        : { ok: false, text: result.error ?? '连接失败' });
    } catch (err) {
      setTest({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateSettings({ provider, api: apiPatch() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="生图设置">
        <header>
          <h2>生图设置</h2>
          <button className="ghost" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <div className="modal-form">
          <div className="field">
            <span>用什么生成图片</span>
            <div className="segmented">
              <button className={provider === 'codex' ? 'active' : ''} onClick={() => setProvider('codex')}>本机 Codex CLI</button>
              <button className={provider === 'api' ? 'active' : ''} onClick={() => setProvider('api')}>图片 API（sub2api 等）</button>
            </div>
          </div>

          {provider === 'codex' ? (
            <p className="hint">
              {settings.codex.available
                ? `调用本机的 ${settings.codex.version}，模型 ${settings.codex.model}，用你 Codex 账号的额度。`
                : '没有找到 codex 命令。安装并登录 Codex CLI，或者改用图片 API。'}
            </p>
          ) : (
            <>
              <p className="hint">调用 OpenAI 兼容的 <code>/v1/images/edits</code> 接口，比如你自己部署的 sub2api。</p>
              <label className="field">
                <span>接口地址</span>
                <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://你的-sub2api-地址（带不带 /v1 都行）" />
              </label>
              <label className="field">
                <span>API Key</span>
                <input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={settings.api.hasKey ? `已保存（${settings.api.keyHint}），留空表示不修改` : 'sk-…'}
                  autoComplete="off"
                />
              </label>
              <div className="grid-2">
                <label className="field">
                  <span>模型</span>
                  <input value={model} onChange={(e) => setModel(e.target.value)} list="image-models" />
                  <datalist id="image-models">
                    {[...new Set([...MODELS, ...models])].map((m) => <option key={m} value={m} />)}
                  </datalist>
                </label>
                <label className="field">
                  <span>质量</span>
                  <select value={quality} onChange={(e) => setQuality(e.target.value)}>
                    {QUALITIES.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
                  </select>
                </label>
              </div>
              <label className="field">
                <span>超时（秒）</span>
                <input type="number" className="num" min={60} max={1800} value={timeout} onChange={(e) => setTimeoutSeconds(Number(e.target.value) || 600)} />
              </label>
              <div className="row">
                <button disabled={busy} onClick={runTest}>测试连接</button>
                <span className="muted hint">只查询模型列表，不会生成图片、不花额度</span>
              </div>
              {test && <p className={test.ok ? 'ok' : 'error'}>{test.text}</p>}
              <p className="muted hint">API Key 只保存在本机的 studio/settings.local.json（不会提交到 git），页面上不会再显示完整的 Key。</p>
            </>
          )}
          {error && <p className="error">{error}</p>}
          <div className="row end">
            <button onClick={onClose}>取消</button>
            <button className="primary" disabled={busy} onClick={save}>保存</button>
          </div>
        </div>
      </div>
    </div>
  );
}

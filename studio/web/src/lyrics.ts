import type { Cue, VideoDoc } from './types';
export const uid = () => crypto.randomUUID();
export const clock = (value: number) => {
  const ticks = Math.round(Math.max(0, Number.isFinite(value) ? value : 0) * 10);
  return `${String(Math.floor(ticks / 600)).padStart(2, '0')}:${((ticks % 600) / 10).toFixed(1).padStart(4, '0')}`;
};
export function importLyrics(text: string, duration: number): { cues: Cue[]; timed: boolean } {
  const raw = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000;
  const timed: { start: number; text: string }[] = [];
  for (const row of raw) {
    const stamps = [...row.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const words = row.replace(/\[[^\]]*\]/g, '').trim();
    for (const stamp of stamps) {
      const start = Number(stamp[1]) * 60 + Number(stamp[2]) + offset;
      if (words && start >= 0 && start < duration) timed.push({ start, text: words });
    }
  }
  if (timed.length) {
    timed.sort((a, b) => a.start - b.start);
    const unique: typeof timed = [];
    for (const line of timed) {
      if (unique.at(-1)?.start === line.start) unique[unique.length - 1].text += '\n' + line.text;
      else unique.push(line);
    }
    return { timed: true, cues: unique.map((c, i) => ({ id: uid(), ...c, end: unique[i + 1]?.start ?? duration, action: '' })) };
  }
  if (/\[\d+:\d/.test(text)) throw new Error('时间戳均超出当前视频时长，请先导入歌曲或调整时长。');
  const lines = raw.filter(s => !/^\[[a-z]+:/i.test(s));
  if (!lines.length) throw new Error('没有读到歌词，请每行填写一句。');
  return { timed: false, cues: lines.map((text, i) => ({ id: uid(), start: i * duration / lines.length, end: (i + 1) * duration / lines.length, text, action: '' })) };
}
export function validate(doc: VideoDoc): string | null {
  if (!doc.title.trim()) return '请填写视频名称';
  if (!Number.isFinite(doc.duration) || doc.duration < .2 || doc.duration > 600) return '视频时长应为 0.2 秒至 10 分钟';
  let end = 0;
  for (const cue of doc.cues) {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start) return '每句歌词的结束时间必须晚于开始时间';
    if (cue.start < end - .001) return '歌词时间发生重叠，请调整起止时间';
    if (cue.end > doc.duration + .001) return '歌词超出了视频时长';
    if (cue.text.length > 160) return '单句歌词最多 160 字，请拆成多句';
    end = cue.end;
  }
  return null;
}

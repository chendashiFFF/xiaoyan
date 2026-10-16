import { orientedStats, type LoadedImage } from './images';
import type { Action, Frame } from './types';

export type FlagKind = 'edge' | 'facing' | 'feet' | 'drift' | 'height' | 'jump' | 'dup';

export interface Flag {
  kind: FlagKind;
  level: 'warn' | 'info';
  message: string;
}

export interface FrameQc {
  loaded: boolean;
  bottom: number;
  massX: number;
  height: number;
  flags: Flag[];
}

export interface ActionQc {
  frames: FrameQc[];
  /** changes[i] = visual change from frame i to the frame played after it (null when they are not adjacent). */
  changes: (number | null)[];
  medianChange: number;
  baseline: number;
  centerX: number;
  warnCount: number;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const diffCache = new Map<string, number>();

interface Placed {
  image: LoadedImage;
  flipX: boolean;
  offset: [number, number];
}

/** Mean colour difference over the pixels either frame covers, both composited on mid-grey. */
export function frameDiff(a: Placed, b: Placed, size: number): number {
  const key = `${a.image.url}@${a.flipX}${a.offset}|${b.image.url}@${b.flipX}${b.offset}`;
  const cached = diffCache.get(key);
  if (cached !== undefined) return cached;
  const step = size > 256 ? 2 : 1;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < size; y += step) {
    for (let x = 0; x < size; x += step) {
      const [ar, ag, ab, aa] = sample(a, x, y);
      const [br, bg, bb, ba] = sample(b, x, y);
      if (aa < 0.06 && ba < 0.06) continue;
      sum += (Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb)) / 3;
      count += 1;
    }
  }
  const value = count ? sum / count : 0;
  if (diffCache.size > 4000) diffCache.clear();
  diffCache.set(key, value);
  return value;
}

function sample({ image, flipX, offset }: Placed, cellX: number, cellY: number): [number, number, number, number] {
  let x = cellX - offset[0];
  const y = cellY - offset[1];
  if (flipX) x = image.width - 1 - x;
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return [128, 128, 128, 0];
  const i = (y * image.width + x) * 4;
  const alpha = image.pixels[i + 3] / 255;
  const grey = 128 * (1 - alpha);
  return [image.pixels[i] * alpha + grey, image.pixels[i + 1] * alpha + grey, image.pixels[i + 2] * alpha + grey, alpha];
}

/**
 * < 1 when the frame looks more like the mirrored reference than the reference itself.
 * Front-facing poses are nearly symmetric and score ~1; a side view facing the other way scores well below.
 */
function facingRatio(reference: Placed, image: LoadedImage, flipX: boolean, size: number): number {
  const refX = orientedStats(reference.image, reference.flipX).massX + reference.offset[0];
  const place = (flip: boolean): Placed => ({
    image,
    flipX: flip,
    offset: [Math.round(refX - orientedStats(image, flip).massX), reference.offset[1]],
  });
  const same = frameDiff(reference, place(flipX), size);
  const mirrored = frameDiff(reference, place(!flipX), size);
  return same ? mirrored / same : 1;
}

export function computeQc(action: Action, images: Map<string, LoadedImage>, urlOf: (frame: Frame) => string): ActionQc {
  const size = action.cellSize;
  const n = action.frames.length;
  const loop = action.playback === 'loop';
  const loaded = action.frames.map((frame) => images.get(urlOf(frame)));
  const metrics = action.frames.map((frame, i) => {
    const image = loaded[i];
    if (!image || image.stats.empty) return null;
    const stats = orientedStats(image, frame.flipX);
    return {
      bottom: stats.maxY + frame.offset[1],
      massX: stats.massX + frame.offset[0],
      height: stats.maxY - stats.minY,
      edge: stats.minX + frame.offset[0] <= 0 || stats.maxX + frame.offset[0] >= size - 1
        || stats.minY + frame.offset[1] <= 0 || stats.maxY + frame.offset[1] >= size - 1,
    };
  });
  const present = metrics.filter((m): m is NonNullable<typeof m> => Boolean(m));
  const baseline = median(present.map((m) => m.bottom));
  const centerX = median(present.map((m) => m.massX));
  const medianHeight = median(present.map((m) => m.height));

  const changes = action.frames.map((frame, i) => {
    let j = i + 1;
    if (j >= n) {
      if (!loop || n < 3) return null;
      j = 0;
    }
    const a = loaded[i];
    const b = loaded[j];
    if (!a || !b) return null;
    return frameDiff(
      { image: a, flipX: Boolean(frame.flipX), offset: frame.offset },
      { image: b, flipX: Boolean(action.frames[j].flipX), offset: action.frames[j].offset },
      size,
    );
  });
  const medianChange = median(changes.filter((c): c is number => c !== null));

  const feetTolerance = Math.max(2, size * 0.012);
  const driftTolerance = Math.max(3, size * 0.025);
  const neighbour = (i: number, delta: number) => {
    const j = i + delta;
    if (j >= 0 && j < n) return j;
    return loop && n >= 3 ? (j + n) % n : -1;
  };

  const first = loaded[0];
  const reference: Placed | null = first && !first.stats.empty
    ? { image: first, flipX: Boolean(action.frames[0].flipX), offset: action.frames[0].offset }
    : null;

  let warnCount = 0;
  const frames = action.frames.map((frame, i): FrameQc => {
    const m = metrics[i];
    if (!m) return { loaded: Boolean(loaded[i]), bottom: 0, massX: 0, height: 0, flags: [] };
    const flags: Flag[] = [];
    if (m.edge) flags.push({ kind: 'edge', level: 'warn', message: '碰到画面边缘，导出时会被裁掉' });
    const image = loaded[i];
    if (i > 0 && reference && image && facingRatio(reference, image, Boolean(frame.flipX), size) < 0.9) {
      flags.push({ kind: 'facing', level: 'warn', message: '朝向和第 1 帧相反（镜像后反而更像），试试"水平翻转"' });
    }
    if (action.grounded) {
      const feet = m.bottom - baseline;
      if (Math.abs(feet) > feetTolerance) {
        flags.push({ kind: 'feet', level: 'warn', message: `脚底比基准线${feet > 0 ? '低' : '高'} ${Math.round(Math.abs(feet))}px` });
      }
      const drift = m.massX - centerX;
      if (Math.abs(drift) > driftTolerance) {
        flags.push({ kind: 'drift', level: 'warn', message: `重心向${drift > 0 ? '右' : '左'}偏 ${Math.round(Math.abs(drift))}px` });
      }
    }
    const around = [neighbour(i, -1), neighbour(i, 1)].map((j) => (j >= 0 ? metrics[j] : null)).filter(Boolean) as NonNullable<typeof m>[];
    if (around.length && medianHeight) {
      const expected = around.reduce((sum, other) => sum + other.height, 0) / around.length;
      const jump = (m.height - expected) / medianHeight;
      if (Math.abs(jump) > 0.1) {
        flags.push({ kind: 'height', level: 'warn', message: `身高比相邻帧${jump > 0 ? '高' : '矮'} ${Math.round(Math.abs(jump) * 100)}%，姿势变化太突然` });
      }
    }
    const previous = neighbour(i, -1);
    const incoming = previous >= 0 ? changes[previous] : null;
    if (incoming !== null && medianChange > 0 && incoming > Math.max(medianChange * 1.8, medianChange + 4)) {
      flags.push({ kind: 'jump', level: 'warn', message: `和上一帧的变化是平均值的 ${(incoming / medianChange).toFixed(1)} 倍，中间可能缺过渡帧` });
    }
    const outgoing = changes[i];
    if (outgoing !== null && medianChange > 0 && outgoing < medianChange * 0.35) {
      flags.push({ kind: 'dup', level: 'info', message: '和下一帧几乎一样，可以删掉一帧、把时长加到另一帧上' });
    }
    warnCount += flags.filter((f) => f.level === 'warn').length;
    return { loaded: true, bottom: m.bottom, massX: m.massX, height: m.height, flags };
  });

  return { frames, changes, medianChange, baseline, centerX, warnCount };
}

/** Offset that puts a frame's feet on `baseline` and/or its centre of mass on `centerX`. */
export function alignedOffset(frame: Frame, image: LoadedImage, target: { baseline: number; centerX: number }, axes: { x: boolean; y: boolean }): [number, number] {
  const stats = orientedStats(image, frame.flipX);
  return [
    axes.x ? Math.round(target.centerX - stats.massX) : frame.offset[0],
    axes.y ? Math.round(target.baseline - stats.maxY) : frame.offset[1],
  ];
}

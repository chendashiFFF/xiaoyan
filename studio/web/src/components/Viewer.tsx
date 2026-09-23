import { useEffect, useRef, useState, type ReactNode } from 'react';
import { orientedStats, type LoadedImage } from '../images';
import type { ActionQc } from '../qc';
import type { Action, Frame, Rect } from '../types';

export interface ViewSettings {
  zoom: 'fit' | number;
  background: string;
  onionPrev: number;
  onionNext: number;
  onionOpacity: number;
  guides: boolean;
}

interface Props {
  action: Action;
  index: number;
  images: Map<string, LoadedImage>;
  urlOf: (frame: Frame) => string;
  qc: ActionQc;
  view: ViewSettings;
  playing: boolean;
  onOffset: (index: number, offset: [number, number], coalesce: string) => void;
  /** Rectangle-selection mode for local repair; the rect is in frame coordinates (before the offset). */
  selecting?: boolean;
  rect?: Rect | null;
  onRect?: (rect: Rect) => void;
  onSelectEnd?: () => void;
  banner?: ReactNode;
}

const PREV_TINT = '#ff4d6d';
const NEXT_TINT = '#3fa7ff';

export function Viewer({ action, index, images, urlOf, qc, view, playing, onOffset, selecting, rect, onRect, onSelectEnd, banner }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; offset: [number, number]; key: string } | null>(null);
  const selectRef = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState({ width: 600, height: 600 });
  const cell = action.cellSize;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const available = Math.min(box.width, box.height) - 32;
  const zoom = view.zoom === 'fit'
    ? (available >= cell ? Math.floor(available / cell) : Math.max(0.25, available / cell))
    : view.zoom;
  const frame = action.frames[index];
  const n = action.frames.length;
  const loop = action.playback === 'loop';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(cell * zoom);
    canvas.width = Math.round(px * dpr);
    canvas.height = Math.round(px * dpr);
    canvas.style.width = `${px}px`;
    canvas.style.height = `${px}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    const scale = zoom * dpr;

    const drawFrame = (target: Frame, alpha: number, tint?: string) => {
      const image = images.get(urlOf(target));
      if (!image) return;
      if (!tint) {
        ctx.save();
        ctx.globalAlpha = alpha;
        if (target.flipX) {
          ctx.translate((target.offset[0] + image.width) * scale, target.offset[1] * scale);
          ctx.scale(-1, 1);
          ctx.drawImage(image.img, 0, 0, image.width * scale, image.height * scale);
        } else {
          ctx.drawImage(image.img, target.offset[0] * scale, target.offset[1] * scale, image.width * scale, image.height * scale);
        }
        ctx.restore();
        return;
      }
      const scratch = scratchRef.current ?? (scratchRef.current = document.createElement('canvas'));
      scratch.width = cell;
      scratch.height = cell;
      const sctx = scratch.getContext('2d')!;
      sctx.clearRect(0, 0, cell, cell);
      sctx.globalCompositeOperation = 'source-over';
      sctx.save();
      if (target.flipX) {
        sctx.translate(target.offset[0] + image.width, target.offset[1]);
        sctx.scale(-1, 1);
        sctx.drawImage(image.img, 0, 0);
      } else {
        sctx.drawImage(image.img, target.offset[0], target.offset[1]);
      }
      sctx.restore();
      sctx.globalCompositeOperation = 'source-atop';
      sctx.fillStyle = tint;
      sctx.globalAlpha = 0.55;
      sctx.fillRect(0, 0, cell, cell);
      sctx.globalAlpha = 1;
      ctx.globalAlpha = alpha;
      ctx.drawImage(scratch, 0, 0, cell * scale, cell * scale);
      ctx.globalAlpha = 1;
    };

    const neighbour = (delta: number) => {
      const j = index + delta;
      if (j >= 0 && j < n) return j;
      return loop ? ((j % n) + n) % n : -1;
    };
    if (!playing) {
      for (let k = view.onionPrev; k >= 1; k -= 1) {
        const j = neighbour(-k);
        if (j >= 0 && j !== index) drawFrame(action.frames[j], view.onionOpacity * (1 - (k - 1) * 0.45), PREV_TINT);
      }
      for (let k = view.onionNext; k >= 1; k -= 1) {
        const j = neighbour(k);
        if (j >= 0 && j !== index) drawFrame(action.frames[j], view.onionOpacity * (1 - (k - 1) * 0.45), NEXT_TINT);
      }
    }
    drawFrame(frame, 1);

    if (view.guides && !playing) {
      ctx.lineWidth = Math.max(1, dpr);
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      if (action.grounded) {
        ctx.strokeStyle = 'rgba(64, 214, 160, .9)';
        const y = (qc.baseline + 1) * scale;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
        const x = (qc.centerX + 0.5) * scale;
        ctx.strokeStyle = 'rgba(64, 214, 160, .55)';
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
      }
      const image = images.get(urlOf(frame));
      if (image && !image.stats.empty) {
        const { minX, maxX, minY, maxY } = orientedStats(image, frame.flipX);
        ctx.strokeStyle = 'rgba(255, 200, 80, .7)';
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.strokeRect((minX + frame.offset[0]) * scale, (minY + frame.offset[1]) * scale, (maxX - minX + 1) * scale, (maxY - minY + 1) * scale);
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255,255,255,.25)';
      ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
    }
    if (rect && !playing) {
      const [x0, y0, x1, y1] = rect;
      const [ox, oy] = frame.offset;
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(0, 255, 90, .04)';
      ctx.fillRect((x0 + ox) * scale, (y0 + oy) * scale, (x1 - x0) * scale, (y1 - y0) * scale);
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = '#27f07a';
      ctx.strokeRect((x0 + ox) * scale, (y0 + oy) * scale, (x1 - x0) * scale, (y1 - y0) * scale);
    }
  }, [action, frame, index, images, urlOf, qc, view, playing, zoom, cell, n, loop, rect]);

  const toCell = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const clamp = (v: number) => Math.max(0, Math.min(cell, v));
    return { x: clamp((event.clientX - box.left) / zoom), y: clamp((event.clientY - box.top) / zoom) };
  };
  const selectionFrom = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => {
    const [ox, oy] = frame.offset;
    const clamp = (v: number) => Math.max(0, Math.min(cell, Math.round(v)));
    return [
      clamp(Math.min(a.x, b.x) - ox), clamp(Math.min(a.y, b.y) - oy),
      clamp(Math.max(a.x, b.x) - ox), clamp(Math.max(a.y, b.y) - oy),
    ];
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || playing || !frame) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (selecting) {
      selectRef.current = toCell(event);
      return;
    }
    dragRef.current = { x: event.clientX, y: event.clientY, offset: frame.offset, key: `drag-${frame.id}-${Date.now()}` };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (selectRef.current) {
      onRect?.(selectionFrom(selectRef.current, toCell(event)));
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const dx = Math.round((event.clientX - drag.x) / zoom);
    const dy = Math.round((event.clientY - drag.y) / zoom);
    const next: [number, number] = [drag.offset[0] + dx, drag.offset[1] + dy];
    if (next[0] !== frame.offset[0] || next[1] !== frame.offset[1]) onOffset(index, next, drag.key);
  };
  const endDrag = () => {
    dragRef.current = null;
    if (selectRef.current) {
      selectRef.current = null;
      onSelectEnd?.();
    }
  };

  const bgStyle = view.background === 'checker' ? undefined : { background: view.background };
  return (
    <div className="viewer" ref={wrapRef}>
      {banner}
      <div className={`viewer-stage ${view.background === 'checker' ? 'checker' : ''}`} style={bgStyle}>
        <canvas
          ref={canvasRef}
          className={playing ? '' : selecting ? 'selecting' : 'draggable'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      </div>
      {frame && (
        <div className="viewer-hud">
          第 {index + 1}/{n} 帧 · {frame.duration}ms · 偏移 ({frame.offset[0]}, {frame.offset[1]}){frame.flipX ? ' · 已翻转' : ''} · {Math.round(zoom * 100)}%
        </div>
      )}
    </div>
  );
}

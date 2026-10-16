import type { Library, VideoDoc, RenderType } from './types';
export const imageUrls = (doc: VideoDoc, lib: Library): string[] => {
  const files = [doc.background === 'builtin-room' ? 'builtin-room.png' : doc.background];
  if (doc.panelImage) files.push(doc.panelImage);
  const character = lib.characters.find(c => c.id === doc.character);
  if (character) character.actions.forEach(a => files.push(...a.frames));
  else if (doc.character) files.push(doc.character);
  return [...new Set(files)].map(s => '/media/' + s);
};
function nineSlice(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const edge = Math.max(1, Math.round(Math.min(image.width, image.height) * .12)), dest = Math.min(38, Math.round(Math.min(w, h) * .2));
  const sx = [0, edge, image.width - edge, image.width], sy = [0, edge, image.height - edge, image.height];
  const dx = [x, x + dest, x + w - dest, x + w], dy = [y, y + dest, y + h - dest, y + h];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) ctx.drawImage(image, sx[col], sy[row], sx[col + 1] - sx[col], sy[row + 1] - sy[row], dx[col], dy[row], dx[col + 1] - dx[col], dy[row + 1] - dy[row]);
}
export function drawScene(canvas: HTMLCanvasElement, doc: VideoDoc, lib: Library, images: Map<string, HTMLImageElement>, t: number, typography: RenderType | null, editorial = false): boolean {
  const ctx = canvas.getContext('2d')!;
  const w = doc.aspect === 'portrait' ? 720 : 1280, h = doc.aspect === 'portrait' ? 1280 : 720;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#171323'; ctx.fillRect(0, 0, w, h);
  const phase = t * Math.PI * 2 / 8;
  const bg = images.get('/media/' + (doc.background === 'builtin-room' ? 'builtin-room.png' : doc.background));
  if (bg) {
    const scale = Math.max(w / bg.width, h / bg.height) * (doc.cameraMotion ? 1 + .045 * doc.motionAmount : 1);
    const sw = Math.round(bg.width * scale), sh = Math.round(bg.height * scale);
    const ox = (sw - w) / 2 + (doc.cameraMotion ? Math.sin(phase) * (sw - w) * .4 : 0), oy = (sh - h) / 2 + (doc.cameraMotion ? Math.cos(phase) * (sh - h) * .4 : 0);
    ctx.drawImage(bg, -Math.round(ox), -Math.round(oy), sw, sh);
  }
  if (doc.lightPulse) { ctx.fillStyle = `rgba(234,184,101,${Math.round((5 + 4 * Math.sin(phase)) * doc.motionAmount) / 255})`; ctx.fillRect(0, 0, w, h); }
  for (let i = 0; i < Math.round(20 + 50 * doc.motionAmount); i++) {
    const mode = doc.atmosphere;
    let x = (i * 137.19 + t * (mode === 'rain' ? 28 : 7)) % w;
    const y = ((i * 83.71 + t * (mode === 'rain' ? 260 : mode === 'snow' ? 24 : -8)) % (h * .78) + h * .78) % (h * .78);
    if (mode === 'rain') { ctx.strokeStyle = 'rgba(169,188,213,.353)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 6, y + 18); ctx.stroke(); }
    else if (['snow', 'dust', 'fireflies'].includes(mode)) {
      x += Math.sin(phase + i) * 12; const r = mode === 'dust' ? 1 : 2;
      ctx.fillStyle = mode === 'snow' ? 'rgba(226,233,242,.55)' : `rgba(235,217,161,${(90 + 70 * Math.sin(phase + i)) / 255})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  const cue = doc.cues.find(c => c.start <= t && t < c.end);
  const character = lib.characters.find(c => c.id === doc.character);
  const action = character?.actions.find(a => a.id === cue?.action) ?? character?.actions.find(a => a.id.endsWith(':idle')) ?? character?.actions[0];
  let frame = doc.character;
  if (action) { let elapsed = ((t - (cue?.start ?? 0)) * 1000) % action.durations.reduce((a, b) => a + b, 0), i = 0; while (i < action.durations.length - 1 && elapsed >= action.durations[i]) { elapsed -= action.durations[i]; i++; } frame = action.frames[i]; }
  const sprite = images.get('/media/' + frame);
  if (sprite) { const sh = Math.round(h * doc.characterScale), sw = Math.round(sh * sprite.width / sprite.height); ctx.drawImage(sprite, Math.round(w * doc.characterX - sw / 2), Math.round(h * doc.characterY - sh), sw, sh); }
  const fade = ctx.createLinearGradient(0, h * .58, 0, h); fade.addColorStop(0, 'rgba(12,15,19,0)'); fade.addColorStop(1, 'rgba(12,15,19,.51)'); ctx.fillStyle = fade; ctx.fillRect(0, 0, w, h);
  const x = Math.round(w * .035), y = Math.round(h * doc.dialogY), bw = Math.round(w * .93), bh = Math.round(h * doc.dialogHeight);
  const panel = images.get('/media/' + doc.panelImage);
  if (panel) { ctx.imageSmoothingEnabled = true; nineSlice(ctx, panel, x, y, bw, bh); ctx.imageSmoothingEnabled = false; }
  else {
    ctx.fillStyle = doc.panelColor; ctx.fillRect(x, y, bw, bh); ctx.lineWidth = 2; ctx.strokeStyle = doc.accentColor; ctx.strokeRect(x + 1, y + 1, bw - 2, bh - 2);
    const inset = ['pixel', 'cream', 'night'].includes(doc.skin) ? 8 : 12; ctx.lineWidth = doc.skin === 'pixel' ? 2 : 1; ctx.strokeRect(x + inset, y + inset, bw - 2 * inset, bh - 2 * inset);
    if (doc.skin === 'ornate') for (const [px, py] of [[x, y], [x + bw, y], [x, y + bh], [x + bw, y + bh]]) { ctx.fillStyle = doc.accentColor; ctx.beginPath(); ctx.moveTo(px - 5, py); ctx.lineTo(px, py - 5); ctx.lineTo(px + 5, py); ctx.lineTo(px, py + 5); ctx.closePath(); ctx.fill(); }
  }
  if (!typography) return false;
  const key = cue?.id ?? '__interlude', glyphs = typography.layouts[key] || [];
  const fraction = cue ? Math.min(1, Math.max(0, (t - cue.start) / Math.max(.01, (cue.end - cue.start) * .85))) : 1;
  const count = Math.max(1, Math.floor(glyphs.length * fraction));
  const reveal = editorial || !cue ? 'line' : doc.reveal;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, bw, bh); ctx.clip();
  glyphs.forEach((g, i) => { if (reveal === 'type' && i >= count) return; const sy = g.sy + (reveal === 'highlight' && i < count ? typography.variantY : 0); ctx.drawImage(typography.image, g.sx, sy, typography.cell, typography.cell, g.x, g.y, typography.cell, typography.cell); }); ctx.restore();
  ctx.drawImage(typography.titleImage, Math.round(w * .05), Math.round(h * .028));
  if (fraction >= 1 && Math.floor(t * 2) % 2 === 0) { const px = x + bw - 25, py = y + bh - 24; ctx.fillStyle = doc.accentColor; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + 9); ctx.lineTo(px + 7, py + 4); ctx.fill(); }
  return typography.overflow.includes(key);
}

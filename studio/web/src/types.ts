export interface Cue { id: string; start: number; end: number; text: string; action: string }
export interface VideoDoc {
  version: 1; title: string; duration: number; aspect: 'portrait' | 'landscape';
  background: string; character: string; audio: string; audioName: string;
  characterX: number; characterY: number; characterScale: number;
  skin: 'cream' | 'night' | 'pixel' | 'ornate' | 'paper'; reveal: 'type' | 'line' | 'highlight'; fontSize: number; rain: boolean; cues: Cue[];
  theme: string; fontId: string; letterSpacing: number; lineHeight: number; textAlign: 'left' | 'center' | 'right';
  textColor: string; highlightColor: string; panelColor: string; accentColor: string; strokeColor: string;
  textStroke: number; textShadow: boolean; textPadding: number; dialogY: number; dialogHeight: number; panelImage: string;
  atmosphere: 'rain' | 'snow' | 'fireflies' | 'dust' | 'none'; cameraMotion: boolean; lightPulse: boolean; motionAmount: number;
}
export interface SpriteAction { id: string; label: string; frames: string[]; durations: number[] }
export interface Character { id: string; name: string; actions: SpriteAction[] }
export interface Asset { id: string; name: string; url: string; kind: string }
export interface StudioFont { id: string; name: string; label?: string; family?: string; url?: string }
export interface Theme { id: string; name: string; caption: string; tag: string; brief: string; settings: Partial<VideoDoc> }
export interface Library { characters: Character[]; backgrounds: { id: string; name: string; file: string }[]; canExport: boolean; fps: number; assets: Asset[]; fonts: StudioFont[]; themes: Theme[] }
export interface ExportJob { id: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; progress: number; url: string | null; error: string | null }
export interface Upload { id: string; name: string; duration?: number; url: string; warning?: string }
export interface ArtJob { id: string; status: 'queued' | 'running' | 'done' | 'failed'; error: string | null; kind: 'background' | 'panel'; asset: Asset | null }
export interface Glyph { sx: number; sy: number; x: number; y: number }
export interface Typography { atlas: string; title: string; cell: number; variantY: number; layouts: Record<string, Glyph[]>; missing: string[]; overflow: string[] }
export interface RenderType extends Typography { image: HTMLImageElement; titleImage: HTMLImageElement }
export interface GeneratorSettings { api: { base: string; model: string; hasKey: boolean; quality: string; timeout: number } }

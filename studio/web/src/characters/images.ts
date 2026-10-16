import { useEffect, useState } from 'react';

export interface FrameStats {
  empty: boolean;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Horizontal centre of mass of the solid pixels; steadier than the bbox centre for flowing hair. */
  massX: number;
}

export interface LoadedImage {
  url: string;
  img: HTMLImageElement;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  stats: FrameStats;
}

const cache = new Map<string, Promise<LoadedImage>>();
const ready = new Map<string, LoadedImage>();

function analyze(pixels: Uint8ClampedArray, width: number, height: number): FrameStats {
  let minX = width, maxX = -1, minY = height, maxY = -1, sumX = 0, weight = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = pixels[(y * width + x) * 4 + 3];
      if (alpha <= 16) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (alpha >= 128) {
        sumX += x;
        weight += 1;
      }
    }
  }
  const empty = maxX < 0;
  return {
    empty,
    minX: empty ? 0 : minX,
    maxX: empty ? 0 : maxX,
    minY: empty ? 0 : minY,
    maxY: empty ? 0 : maxY,
    massX: weight ? sumX / weight : width / 2,
  };
}

/** Stats of the image as displayed, i.e. after an optional horizontal mirror. */
export function orientedStats(image: LoadedImage, flipX = false): FrameStats {
  if (!flipX || image.stats.empty) return image.stats;
  const { stats, width } = image;
  return { ...stats, minX: width - 1 - stats.maxX, maxX: width - 1 - stats.minX, massX: width - 1 - stats.massX };
}

export function loadImage(url: string): Promise<LoadedImage> {
  let pending = cache.get(url);
  if (!pending) {
    pending = new Promise<LoadedImage>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const loaded = {
          url,
          img,
          width: canvas.width,
          height: canvas.height,
          pixels,
          stats: analyze(pixels, canvas.width, canvas.height),
        };
        ready.set(url, loaded);
        resolve(loaded);
      };
      img.onerror = () => {
        cache.delete(url);
        reject(new Error(`无法加载图片 ${url}`));
      };
      img.src = url;
    });
    cache.set(url, pending);
  }
  return pending;
}

/** Returns every image in `urls` that has finished loading; re-renders as more arrive. */
export function useImages(urls: string[]): Map<string, LoadedImage> {
  const key = urls.join('|');
  const [, bump] = useState(0);
  useEffect(() => {
    let alive = true;
    for (const url of urls) {
      if (ready.has(url)) continue;
      loadImage(url).then(() => alive && bump((n) => n + 1), () => alive && bump((n) => n + 1));
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const result = new Map<string, LoadedImage>();
  for (const url of urls) {
    const image = ready.get(url);
    if (image) result.set(url, image);
  }
  return result;
}

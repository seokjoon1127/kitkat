import { nanoid } from 'nanoid';
import type { ProjectDoc } from './index.js';

export function newId(): string {
  return nanoid();
}

export function createEmptyProject(opts: { name: string; width?: number; height?: number; fps?: number }): ProjectDoc {
  return {
    schemaVersion: 1,
    id: newId(),
    name: opts.name,
    revision: 0,
    settings: {
      width: opts.width ?? 1080,
      height: opts.height ?? 1920,
      fps: opts.fps ?? 30,
      background: { kind: 'color', color: '#000000' },
    },
    assets: {},
    tracks: [
      { id: newId(), kind: 'video', name: '비디오', clips: [] },
      { id: newId(), kind: 'text', name: '텍스트', clips: [] },
      { id: newId(), kind: 'audio', name: '오디오', clips: [] },
    ],
  };
}

// W8 F17 리뷰 #3 — 파생 프록시도 원본 프록시와 같은 판 표시·같은 인코딩이어야 한다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROXY_TAG, isCurrentProxy, makeDerivedProxy, makeProxy, probeAsset } from '../src/index.js';
import { deriveMedia } from '../src/derive.js';

const T = 180_000;
let dir: string;
let src: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kitkat-proxyver-'));
  src = path.join(dir, 'src.mp4');
  await execa('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
}, T);
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

async function keyframeRatio(abs: string): Promise<number> {
  const { stdout } = await execa('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', abs]);
  const flags = stdout.trim().split(/\r?\n/);
  return flags.filter((f) => f.startsWith('1')).length / flags.length;
}

describe('프록시 판 표시', () => {
  it('원본 프록시와 파생 프록시가 같은 태그를 쓰고, isCurrentProxy 가 둘 다 지금 판으로 본다', async () => {
    const mainRel = await makeProxy(src, dir, 'asset1');
    expect(mainRel).toBe(`proxies/asset1.${PROXY_TAG}.mp4`);
    expect(isCurrentProxy(mainRel)).toBe(true);

    // 파생 본체를 하나 굽고(색조정 한 패스), 그 프록시 이름을 본다
    const out = await deriveMedia(src, dir, 'asset1', 'kkey', { hueSat: [{ id: 'h', bands: ['r'], hue: 5, saturation: 0, intensity: 0 }] });
    expect(out.proxySrc).toBe(`derived/asset1.kkey.p.${PROXY_TAG}.mp4`);
    expect(isCurrentProxy(out.proxySrc)).toBe(true);
  }, T);

  it('makeDerivedProxy — 본체를 다시 굽지 않고 540p 사본만 만들며 키프레임 간격도 같다', async () => {
    const out = await deriveMedia(src, dir, 'asset2', 'k2', { hueSat: [{ id: 'h', bands: ['r'], hue: 5, saturation: 0, intensity: 0 }] });
    const rel = await makeDerivedProxy(path.join(dir, out.src), dir, 'asset2', 'k2');
    expect(rel).toBe(`derived/asset2.k2.p.${PROXY_TAG}.mp4`);
    const p = await probeAsset(path.join(dir, rel));
    expect(p.kind).toBe('video');
    expect(p.height).toBe(540);
    // 원본 프록시와 «같은 인코딩»: 키프레임 비율이 같은 규칙(1/15 이상)
    const mainRel = await makeProxy(src, dir, 'asset2');
    const rMain = await keyframeRatio(path.join(dir, mainRel));
    const rDerived = await keyframeRatio(path.join(dir, rel));
    expect(rDerived).toBeGreaterThanOrEqual(1 / 15 - 1e-9);
    expect(Math.abs(rDerived - rMain)).toBeLessThan(0.05);
  }, T);
});

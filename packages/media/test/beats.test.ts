import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beatsFromPcm, detectBeats } from '../src/index.js';

const T = 300_000;
const SR = 22050;

/** 결정적(고정 시드) 5ms 노이즈 버스트 클릭 트랙. */
function makeClickTrack(
  sampleRate: number,
  totalMs: number,
  clickTimesMs: number[],
  amp = 16000,
): Int16Array {
  const pcm = new Int16Array(Math.round((totalMs / 1000) * sampleRate));
  let seed = 123456789;
  const rand = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const burst = Math.round(sampleRate * 0.005);
  for (const t of clickTimesMs) {
    const start = Math.round((t / 1000) * sampleRate);
    for (let i = 0; i < burst && start + i < pcm.length; i++) {
      pcm[start + i] = Math.round((rand() * 2 - 1) * amp);
    }
  }
  return pcm;
}

/** PCM(mono s16) → 표준 44바이트 헤더 WAV. */
function wavFromPcm(pcm: Int16Array, sampleRate: number): Buffer {
  const dataSize = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i]!, 44 + i * 2);
  return buf;
}

/** 진폭 amp 의 지속 사인 톤 (t=0 부터 소리가 있다). */
function makeTone(sampleRate: number, totalMs: number, freqs: number[], amp: number): Int16Array {
  const pcm = new Int16Array(Math.round((totalMs / 1000) * sampleRate));
  for (let i = 0; i < pcm.length; i++) {
    let v = 0;
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / sampleRate);
    pcm[i] = Math.round((v / freqs.length) * amp);
  }
  return pcm;
}

/** 결정적(고정 시드) 화이트 노이즈. */
function makeNoise(sampleRate: number, totalMs: number): Int16Array {
  const pcm = new Int16Array(Math.round((totalMs / 1000) * sampleRate));
  let seed = 1;
  for (let i = 0; i < pcm.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    pcm[i] = Math.round(((seed / 0x7fffffff) * 2 - 1) * 16000);
  }
  return pcm;
}

const CLICKS = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500];

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'kitkat-beats-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('beatsFromPcm', () => {
  it('500ms 간격 클릭 트랙의 비트를 전부 ±30ms 안에 찾는다', () => {
    const beats = beatsFromPcm(makeClickTrack(SR, 6000, CLICKS), SR);
    expect(beats.length).toBe(CLICKS.length);
    for (let i = 0; i < CLICKS.length; i++) {
      expect(Math.abs(beats[i]! - CLICKS[i]!)).toBeLessThanOrEqual(30);
    }
  }, T);

  it('결과는 정수 ms 오름차순', () => {
    const beats = beatsFromPcm(makeClickTrack(SR, 6000, CLICKS), SR);
    for (let i = 0; i < beats.length; i++) {
      expect(Number.isInteger(beats[i])).toBe(true);
      if (i > 0) expect(beats[i]!).toBeGreaterThan(beats[i - 1]!);
    }
  }, T);

  it('무음이면 빈 배열', () => {
    expect(beatsFromPcm(new Int16Array(SR * 3), SR)).toEqual([]);
  }, T);

  it('창 길이보다 짧은 입력은 빈 배열', () => {
    expect(beatsFromPcm(new Int16Array(1024), SR)).toEqual([]);
  }, T);

  it('200ms 최소 간격: 120ms 떨어진 두 클릭은 하나로 합쳐진다', () => {
    const beats = beatsFromPcm(makeClickTrack(SR, 3000, [1000, 1120]), SR);
    expect(beats.length).toBe(1);
    expect(Math.abs(beats[0]! - 1000)).toBeLessThanOrEqual(30);
  }, T);

  // --- 회귀: t=0 부터 소리가 있으면 첫 프레임이 통째로 플럭스가 되어 ~46ms 에
  // 가짜 비트가 생기던 버그. 온셋이 없는 신호는 비트가 0개여야 한다. ---

  it('440Hz 지속 톤에는 온셋이 없으므로 비트가 없다', () => {
    expect(beatsFromPcm(makeTone(SR, 3000, [440], 16000), SR)).toEqual([]);
  }, T);

  it('220+440Hz 지속 화음에도 비트가 없다', () => {
    expect(beatsFromPcm(makeTone(SR, 3000, [220, 440], 16000), SR)).toEqual([]);
  }, T);

  it('DC 풀스케일에는 비트가 없다', () => {
    const pcm = new Int16Array(SR * 3);
    pcm.fill(32767);
    expect(beatsFromPcm(pcm, SR)).toEqual([]);
  }, T);

  it('화이트 노이즈에는 비트가 없다', () => {
    expect(beatsFromPcm(makeNoise(SR, 3000), SR)).toEqual([]);
  }, T);

  it('t=0 부터 소리가 있어도 첫 홉(~46ms) 근처에 가짜 비트가 생기지 않는다', () => {
    // 앞의 무음 없이 t=0 에서 바로 시작하되 1초마다 진짜 온셋이 있는 신호.
    const pcm = makeTone(SR, 3000, [440], 16000);
    const clicks = makeClickTrack(SR, 3000, [1000, 2000]);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, pcm[i]! + clicks[i]!));
    const beats = beatsFromPcm(pcm, SR);
    expect(beats.every((ms) => ms > 100)).toBe(true); // 46ms 인공물 없음
    expect(beats.length).toBe(2);
    expect(Math.abs(beats[0]! - 1000)).toBeLessThanOrEqual(30);
    expect(Math.abs(beats[1]! - 2000)).toBeLessThanOrEqual(30);
  }, T);

  it('앞에 무음을 붙여도 같은 온셋만 찾는다 (첫 프레임 처리에 결과가 좌우되지 않는다)', () => {
    const bare = beatsFromPcm(makeClickTrack(SR, 3000, [500, 1000, 1500]), SR);
    const padded = beatsFromPcm(makeClickTrack(SR, 3200, [700, 1200, 1700]), SR);
    expect(bare.length).toBe(3);
    expect(padded.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(bare[i]! - (500 + i * 500))).toBeLessThanOrEqual(30);
      expect(Math.abs(padded[i]! - (700 + i * 500))).toBeLessThanOrEqual(30);
    }
  }, T);

  it('작은 진폭(-40dB)의 클릭도 같은 시각에 검출한다 (기준이 진폭에 비례)', () => {
    const loud = beatsFromPcm(makeClickTrack(SR, 6000, CLICKS), SR);
    const quiet = beatsFromPcm(makeClickTrack(SR, 6000, CLICKS, 160), SR);
    expect(quiet).toEqual(loud);
  }, T);
});

describe('detectBeats', () => {
  it('wav 파일에서 ffmpeg PCM 추출로 같은 비트를 찾는다', async () => {
    const wavAbs = path.join(tmpDir, 'clicks.wav');
    await writeFile(wavAbs, wavFromPcm(makeClickTrack(SR, 6000, CLICKS), SR));
    const beats = await detectBeats(wavAbs);
    expect(beats.length).toBe(CLICKS.length);
    for (let i = 0; i < CLICKS.length; i++) {
      expect(Math.abs(beats[i]! - CLICKS[i]!)).toBeLessThanOrEqual(30);
    }
  }, T);

  it('t=0 부터 지속되는 톤 wav 에서는 비트를 찾지 않는다', async () => {
    const wavAbs = path.join(tmpDir, 'tone.wav');
    await writeFile(wavAbs, wavFromPcm(makeTone(SR, 3000, [440], 16000), SR));
    expect(await detectBeats(wavAbs)).toEqual([]);
  }, T);
});

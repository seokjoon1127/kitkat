// W8 F12-B — 파형 파일 두 형식 (옛 배열 / 새 객체) 읽기
import { describe, expect, it } from 'vitest';
import { parseWaveform, toEnvelope } from '../src/waveform.js';

describe('parseWaveform', () => {
  it('옛 형식(1000버킷 배열)을 legacy 로 읽는다 — 타임라인 그리기는 계속 된다', () => {
    const w = parseWaveform([0.1, 0.3, 0.2]);
    expect(w).toEqual({ kind: 'legacy', peaks: [0.1, 0.3, 0.2] });
  });

  it('새 형식(bucketMs·peaks·rms)을 bucketed 로 읽는다', () => {
    const w = parseWaveform({ bucketMs: 20, peaks: [0.5], rms: [0.3] });
    expect(w).toEqual({ kind: 'bucketed', bucketMs: 20, peaks: [0.5], rms: [0.3] });
  });

  it('망가진 파일은 null', () => {
    expect(parseWaveform(null)).toBeNull();
    expect(parseWaveform({})).toBeNull();
    expect(parseWaveform({ bucketMs: 0, peaks: [], rms: [] })).toBeNull();
    expect(parseWaveform({ bucketMs: 20, peaks: [0.1] })).toBeNull();   // rms 가 없다
    expect(parseWaveform(['a', 'b'])).toBeNull();
  });
});

describe('toEnvelope', () => {
  it('새 형식만 더킹 포락선이 된다', () => {
    expect(toEnvelope(parseWaveform({ bucketMs: 20, peaks: [0.5], rms: [0.3] }))).toEqual({
      bucketMs: 20,
      rms: [0.3],
    });
  });

  it('옛 형식은 null — 버킷 시간을 몰라 시각을 계산할 수 없다 (조용히 근사하지 않는다)', () => {
    expect(toEnvelope(parseWaveform([0.1, 0.2]))).toBeNull();
    expect(toEnvelope(null)).toBeNull();
  });
});

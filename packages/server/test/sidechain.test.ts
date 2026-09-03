// W8 F12-A — 사이드체인 더킹의 «순수» 부분 (ffmpeg 없이 도는 것만).
// 실제 믹스 품질은 실측 스크립트로 재고 그 숫자를 계획서에 남긴다.
import { describe, expect, it } from 'vitest';
import { createEmptyProject, type ProjectDoc } from '@kitkat/schema';
import {
  DETECT_LUFS,
  DUCK_RATIO,
  amountToDb,
  correctThresholdDb,
  estimatePlainRenderSeconds,
  estimateSidechainSeconds,
  findDuckPairs,
  levelScGain,
  nextThresholdDb,
  selectExpr,
  sidechainGraph,
  stripVolumeKeyframes,
  thresholdDbFor,
  thresholdLinear,
} from '../src/sidechain.js';

function docWithTracks(): ProjectDoc {
  const doc = createEmptyProject({ name: 'duck' });
  doc.tracks.push({ id: 'music', kind: 'audio', name: '음악', clips: [] });
  doc.tracks.push({ id: 'narr', kind: 'audio', name: '나레이션', clips: [] });
  return doc;
}

describe('amountToDb / threshold 역산', () => {
  it('배율 → dB (미리보기와 렌더가 같은 숫자를 쓴다)', () => {
    expect(amountToDb(1)).toBeCloseTo(0, 6);
    expect(amountToDb(0.5)).toBeCloseTo(6.02, 2);
    expect(amountToDb(0.25)).toBeCloseTo(12.04, 2);
    expect(amountToDb(0.125)).toBeCloseTo(18.06, 2);
  });

  it('threshold 는 L_sc - D/0.75 (ratio 4)', () => {
    expect(thresholdDbFor(0.25)).toBeCloseTo(DETECT_LUFS - 12.04 / (1 - 1 / DUCK_RATIO), 2);
  });

  it('threshold 선형값은 sidechaincompress 범위(0.000977..1)로 클램프된다', () => {
    expect(thresholdLinear(-200)).toBeCloseTo(0.000977, 6);
    expect(thresholdLinear(20)).toBe(1);
    expect(thresholdLinear(-20)).toBeCloseTo(0.1, 6);
  });

  it('보정은 «더 눌리는» 쪽으로 간다 — 부호를 뒤집으면 목표에서 멀어진다', () => {
    // 실측: threshold -32.05dB 에서 -7.1dB (목표 -12.04dB) → 임계를 «내려야» 더 눌린다
    const next = correctThresholdDb(-32.05, -7.1, -12.04);
    expect(next).toBeLessThan(-32.05);
    expect(next).toBeCloseTo(-38.64, 1);
  });

  it('두 점을 얻으면 실측 기울기(할선법)로 갈아탄다', () => {
    // (-32.05, -7.1) → (-38.64, -9.6): 기울기 0.379 (모형값 0.75 의 절반)
    const history = [
      { thresholdDb: -32.05, actualDb: -7.1 },
      { thresholdDb: -38.64, actualDb: -9.6 },
    ];
    const next = nextThresholdDb(history, -12.04);
    expect(next).toBeCloseTo(-45.08, 1);
    // 모형 기울기만 썼다면 -41.9 에 그쳐 또 모자랐을 것이다
    expect(next).toBeLessThan(correctThresholdDb(-38.64, -9.6, -12.04));
  });

  it('첫 보정은 모형 기울기 0.75 를 쓴다 (점이 하나뿐이라 기울기를 모른다)', () => {
    expect(nextThresholdDb([{ thresholdDb: -32.05, actualDb: -7.1 }], -12.04)).toBeCloseTo(-38.64, 1);
  });

  it('퇴화한 기울기(0 이나 음수)는 모형값으로 물러선다', () => {
    const flat = [
      { thresholdDb: -30, actualDb: -5 },
      { thresholdDb: -40, actualDb: -5 },   // 아무 변화가 없다
    ];
    expect(nextThresholdDb(flat, -12)).toBeCloseTo(correctThresholdDb(-40, -5, -12), 6);
  });
});

describe('level_sc — 조용한 나레이션 함정', () => {
  it('트리거를 감지 경로에서만 -16 LUFS 로 끌어올린다', () => {
    expect(levelScGain(-16)).toBeCloseTo(1, 6);
    expect(levelScGain(-22.92)).toBeCloseTo(2.218, 3);   // 실측 트리거
    expect(levelScGain(-34.6)).toBeCloseTo(8.51, 2);     // 진폭 0.1 짜리 조용한 나레이션
  });

  it('범위(0.015625..64) 밖은 클램프하고 -inf 는 1 로 둔다', () => {
    expect(levelScGain(-200)).toBe(64);
    expect(levelScGain(60)).toBe(0.015625);
    expect(levelScGain(-Infinity)).toBe(1);
  });
});

describe('필터그래프', () => {
  const opts = {
    levelSc: 2.218, threshold: 0.025, attackMs: 100, releaseMs: 400, videoHasAudio: true,
  };

  it('트리거를 asplit 으로 쪼갠다 — 감지용과 «들리는» 경로', () => {
    const g = sidechainGraph(opts);
    expect(g).toContain('[2:a]asplit=2[vdet][vout]');
    expect(g).toContain('[1:a][vdet]sidechaincompress=');
  });

  it('들리는 나레이션에는 아무 필터도 안 붙는다 (loudnorm 을 asplit 앞에 걸지 않는다)', () => {
    const g = sidechainGraph(opts);
    expect(g).not.toContain('loudnorm');
    // 게인 보정은 감지 경로의 level_sc 로만 한다
    expect(g).toContain('level_sc=2.218');
  });

  it('amix 는 normalize=0 — 안 그러면 전체가 1/N 로 작아진다', () => {
    expect(sidechainGraph(opts)).toContain('amix=inputs=3:duration=longest:normalize=0');
    expect(sidechainGraph({ ...opts, videoHasAudio: false })).toContain('amix=inputs=2');
  });

  it('측정용 그래프는 «눌린 음악만» 낸다 (나레이션이 섞이면 감쇠를 못 잰다)', () => {
    const g = sidechainGraph({ ...opts, duckedOnly: true });
    expect(g).toBe(
      '[0:a][1:a]sidechaincompress=level_sc=2.218:threshold=0.025:ratio=4:attack=100:release=400' +
        ':makeup=1:knee=6:detection=rms:link=average[out]',
    );
  });

  it('attack·release 는 sidechaincompress 범위로 클램프된다', () => {
    const g = sidechainGraph({ ...opts, attackMs: 0, releaseMs: 99999 });
    expect(g).toContain('attack=0.01');
    expect(g).toContain('release=9000');
  });
});

describe('selectExpr', () => {
  it('구간들을 between 합으로 만든다 (필터 인자용으로 쉼표를 이스케이프)', () => {
    expect(selectExpr([{ start: 3000, end: 7000 }])).toBe('between(t\\,3.000\\,7.000)');
    expect(selectExpr([{ start: 0, end: 1000 }, { start: 2500, end: 3000 }])).toBe(
      'between(t\\,0.000\\,1.000)+between(t\\,2.500\\,3.000)',
    );
  });

  it('구간이 없으면 전체(1)', () => {
    expect(selectExpr([])).toBe('1');
  });
});

describe('findDuckPairs · stripVolumeKeyframes', () => {
  it('duckedBy 와 duck 이 둘 다 있고 트리거가 실재할 때만 쌍이다', () => {
    const doc = docWithTracks();
    expect(findDuckPairs(doc)).toEqual([]);

    const music = doc.tracks.find((t) => t.id === 'music')!;
    music.duckedBy = 'narr';                                // duck 이 없다
    expect(findDuckPairs(doc)).toEqual([]);

    music.duck = { amount: 0.25, attackMs: 400, releaseMs: 400 };
    music.duckedBy = 'nope';                                // 없는 트랙
    expect(findDuckPairs(doc)).toEqual([]);

    music.duckedBy = 'narr';
    expect(findDuckPairs(doc)).toEqual([
      { duckedTrackId: 'music', triggerTrackId: 'narr', duck: { amount: 0.25, attackMs: 400, releaseMs: 400 } },
    ]);
  });

  it('amount 1(=안 낮춤)이면 쌍이 아니다 — 스템 2장 값을 치를 이유가 없다', () => {
    const doc = docWithTracks();
    const music = doc.tracks.find((t) => t.id === 'music')!;
    music.duckedBy = 'narr';
    music.duck = { amount: 1, attackMs: 400, releaseMs: 400 };
    expect(findDuckPairs(doc)).toEqual([]);
  });

  it('눌릴 트랙의 volume 키프레임만 지운다 (이중 더킹 방지) — 원본 doc 은 안 건드린다', () => {
    const doc = docWithTracks();
    doc.assets.a1 = { id: 'a1', kind: 'audio', src: 'assets/a1.wav', name: 'a', duration: 10000 };
    doc.tracks.find((t) => t.id === 'music')!.clips.push({
      id: 'm1', kind: 'audio', assetId: 'a1', start: 0, duration: 10000,
      in: 0, out: 10000, speed: 1, volume: 1,
      keyframes: [
        { time: 0, prop: 'volume', value: 1, easing: 'linear' },
        { time: 500, prop: 'volume', value: 0.25, easing: 'linear' },
      ],
    });
    const stripped = stripVolumeKeyframes(doc, 'music');
    expect(stripped.tracks.find((t) => t.id === 'music')!.clips[0]!.keyframes).toBeUndefined();
    expect(doc.tracks.find((t) => t.id === 'music')!.clips[0]!.keyframes).toHaveLength(2);   // 원본 보존
  });
});

describe('예상 시간', () => {
  it('사이드체인은 스템 2장 때문에 2배 넘게 걸린다 (5초 실측 기준)', () => {
    const plain = estimatePlainRenderSeconds(5000);
    const side = estimateSidechainSeconds(5000);
    expect(plain).toBe(22);
    expect(side).toBe(65);                      // 22.24 + 21×2 + 0.72
    expect(side / plain).toBeGreaterThan(2);
  });

  it('길이에 비례한다', () => {
    expect(estimateSidechainSeconds(30_000)).toBe(estimateSidechainSeconds(5000) * 6);
  });
});

// 크로마키 재작성 (W6 T1) — 색차 공간 투영 판정 + 디스필.
// v1 은 RGB 를 키 색 방향에 그대로 투영해서 **밝을수록 지워졌다**. 여기 테스트의 핵심은
// 「지워지면 안 되는 색이 정말 안 지워지는가」다.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHROMA_SPILL,
  chromaKeyAlphaFactor,
  chromaKeyDespill,
  chromaKeyParams,
  chromaKeyScore,
} from '../src/composition/svg-data.js';
import { buildFilterNodes } from '../src/composition/svg-filters.js';

const KEY = '#00b140'; // 실촬영 그린스크린 표준색
const hex = (s: string): [number, number, number] => {
  const v = parseInt(s.replace('#', ''), 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
};

const ck = (o: Partial<{ color: string; similarity: number; smoothness: number; spill: number }> = {}) =>
  chromaKeyParams({ color: KEY, similarity: 0.4, smoothness: 0.1, ...o });

const alphaOf = (p: ReturnType<typeof ck>, color: string): number =>
  chromaKeyAlphaFactor(p, ...hex(color));

// 지워지면 안 되는 색들 (실측 격차 G1 의 피해자들)
const KEEP = {
  밝은피부: '#e8b48c',
  흰옷: '#ffffff',
  하늘색옷: '#87ceeb',
  어두운피부: '#4a2f1e',
  빨간옷: '#c0392b',
} as const;

describe('크로마키 판정식 — 휘도를 뺀 색차 투영', () => {
  it('계획서 D14 표의 점수를 그대로 낸다 (키 0.539 vs 다음 0.139 — 약 4배 여유)', () => {
    const p = ck();
    expect(chromaKeyScore(p, ...hex(KEY))).toBeCloseTo(0.539, 3);
    expect(chromaKeyScore(p, ...hex(KEEP.밝은피부))).toBeCloseTo(-0.082, 3);
    expect(chromaKeyScore(p, ...hex(KEEP.흰옷))).toBeCloseTo(0.0, 6);
    expect(chromaKeyScore(p, ...hex(KEEP.하늘색옷))).toBeCloseTo(0.139, 3);
    // 어두운 피부·빨간 옷은 음수 — 키 색과 반대 방향
    expect(chromaKeyScore(p, ...hex(KEEP.어두운피부))).toBeLessThan(0);
    expect(chromaKeyScore(p, ...hex(KEEP.빨간옷))).toBeLessThan(0);
  });

  it('키 그린은 지워진다 (알파 0)', () => {
    expect(alphaOf(ck(), KEY)).toBe(0);
    // 최관대(similarity 0)면 임계가 키 색 자신의 점수와 같아진다 → 램프 한가운데 = 0.5.
    // v1 은 여기서 **1**(안 지워짐)이었다 — 그게 G1 의 절반이다.
    expect(alphaOf(ck({ similarity: 0 }), KEY)).toBeCloseTo(0.5, 6);
    // similarity 를 조금만 올리면 완전히 지워진다
    expect(alphaOf(ck({ similarity: 0.1 }), KEY)).toBe(0);
  });

  it('밝은 피부·흰옷·어두운 피부·빨간 옷은 similarity 를 어떻게 줘도 안 지워진다', () => {
    for (const s of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const p = ck({ similarity: s });
      for (const name of ['밝은피부', '흰옷', '어두운피부', '빨간옷'] as const) {
        expect(`${name}@${s}=${alphaOf(p, KEEP[name])}`).toBe(`${name}@${s}=1`);
      }
    }
  });

  it('하늘색 옷은 실사용 범위에서 안 지워진다 (키 색과 가장 가까운 색인데도)', () => {
    // 하늘색은 남는 색 중 점수가 가장 높다(0.139). 그래도 키(0.539)와 4배 차이라
    // similarity 0.6 까지는 전혀 안 깎이고, 아주 공격적인 0.8 에서도 96% 남는다.
    for (const s of [0, 0.2, 0.4, 0.6]) {
      expect(alphaOf(ck({ similarity: s }), KEEP.하늘색옷)).toBe(1);
    }
    expect(alphaOf(ck({ similarity: 0.8 }), KEEP.하늘색옷)).toBeGreaterThan(0.9);
  });

  it('v1 결함 회귀 — 밝기가 판정을 바꾸지 않는다 (흰색·회색·검정 모두 점수 0)', () => {
    const p = ck();
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      expect(chromaKeyScore(p, v, v, v)).toBeCloseTo(0, 10);
      expect(chromaKeyAlphaFactor(p, v, v, v)).toBe(1);
    }
    // 같은 색을 밝기만 바꿔도 (색차 크기에 비례할 뿐) 임계를 넘지 않는다
    const [r, g, b] = hex(KEEP.밝은피부);
    for (const k of [0.4, 0.7, 1]) {
      expect(chromaKeyAlphaFactor(p, r * k, g * k, b * k)).toBe(1);
    }
  });

  it('similarity 가 클수록 임계가 낮아져 더 많이 지운다 (방향은 v1 과 동일)', () => {
    const ts = [0, 0.25, 0.5, 0.75, 1].map((s) => ck({ similarity: s }).t);
    for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeLessThan(ts[i - 1]!);
    // similarity=1 에서도 임계는 0 이 아니다 (계수 0.9 하한)
    expect(ts[ts.length - 1]!).toBeGreaterThan(0);
    // 키 그린과 밝은 피부의 중간색: 관대하면 남고 공격적이면 지워진다
    const mid = (i: number): [number, number, number] => {
      const a = hex(KEY);
      const b = hex(KEEP.밝은피부);
      return [a[0] * i + b[0] * (1 - i), a[1] * i + b[1] * (1 - i), a[2] * i + b[2] * (1 - i)];
    };
    expect(chromaKeyAlphaFactor(ck({ similarity: 0.1 }), ...mid(0.75))).toBe(1);
    expect(chromaKeyAlphaFactor(ck({ similarity: 0.8 }), ...mid(0.75))).toBe(0);
  });

  it('smoothness 가 클수록 램프가 넓어져 반투명 구간이 생긴다', () => {
    const hard = ck({ smoothness: 0 });
    const soft = ck({ smoothness: 1 });
    expect(soft.w).toBeGreaterThan(hard.w);
    expect(hard.w).toBe(0.01); // 하한
    // 임계 정확히 위의 색은 두 설정 모두 0.5 (램프 중앙)
    const atT = (p: ReturnType<typeof ck>): number => {
      // m = t 가 되는 초록 비율을 찾아 알파를 본다
      const k = p.t / p.mKey;
      const [r, g, b] = hex(KEY);
      return chromaKeyAlphaFactor(p, r * k, g * k, b * k);
    };
    expect(atT(hard)).toBeCloseTo(0.5, 6);
    expect(atT(soft)).toBeCloseTo(0.5, 6);
    // 임계에서 0.02 떨어진 곳: 좁은 램프는 이미 0/1, 넓은 램프는 중간값
    const off = (p: ReturnType<typeof ck>, d: number): number => {
      const k = (p.t + d) / p.mKey;
      const [r, g, b] = hex(KEY);
      return chromaKeyAlphaFactor(p, r * k, g * k, b * k);
    };
    expect(off(hard, 0.02)).toBe(0);
    expect(off(soft, 0.02)).toBeGreaterThan(0);
    expect(off(soft, 0.02)).toBeLessThan(0.5);
  });

  it('spill 기본값은 0.5 이고 0 이면 디스필을 끈다 (v1 문서 = spill 없음 → 기본 적용)', () => {
    expect(DEFAULT_CHROMA_SPILL).toBe(0.5);
    const dflt = chromaKeyParams({ color: KEY, similarity: 0.4, smoothness: 0.1 });
    const half = chromaKeyParams({ color: KEY, similarity: 0.4, smoothness: 0.1, spill: 0.5 });
    expect(dflt.v).toEqual(half.v);
    expect(dflt.despill).toBe(true);
    const none = chromaKeyParams({ color: KEY, similarity: 0.4, smoothness: 0.1, spill: 0 });
    expect(none.despill).toBe(false);
    expect(none.v.every((x) => x === 0)).toBe(true);
    const full = chromaKeyParams({ color: KEY, similarity: 0.4, smoothness: 0.1, spill: 1 });
    expect(Math.hypot(...full.v)).toBeCloseTo(1, 6); // |v| = spill
    expect(Math.hypot(...half.v)).toBeCloseTo(0.5, 6);
  });

  it('디스필은 임계를 넘은 만큼만 초록을 빼고 휘도는 보존한다', () => {
    // 임계를 넉넉히 넘는 초록 물든 색 (키 색 90%)
    const p = ck({ similarity: 0.6 });
    const [r, g, b] = [0.1, 0.65, 0.25];
    const before = { r, g, b };
    const [r2, g2, b2] = chromaKeyDespill(p, r, g, b);
    expect(g2).toBeLessThan(before.g); // 초록이 빠지고
    expect(r2).toBeGreaterThan(before.r); // 남은 두 채널은 올라간다
    expect(b2).toBeGreaterThan(before.b);
    // 색차 방향으로만 뺐으므로 휘도는 그대로 (v·(0.299,0.587,0.114) = 0)
    const luma = (x: number, y: number, z: number) => 0.299 * x + 0.587 * y + 0.114 * z;
    expect(luma(r2, g2, b2)).toBeCloseTo(luma(r, g, b), 6);
    // 임계 아래(= 지우지 않는 색)는 건드리지 않는다
    expect(chromaKeyDespill(p, ...hex(KEEP.밝은피부))).toEqual(hex(KEEP.밝은피부));
    // spill 0 이면 아무것도 안 바뀐다
    expect(chromaKeyDespill(ck({ similarity: 0.6, spill: 0 }), r, g, b)).toEqual([r, g, b]);
  });

  it('무채색 키(#ffffff·#808080)는 색으로 구분할 수 없으므로 아무것도 지우지 않는다', () => {
    for (const color of ['#ffffff', '#808080', '#000000']) {
      const p = chromaKeyParams({ color, similarity: 1, smoothness: 0.5 });
      expect(p.disabled).toBe(true);
      for (const c of Object.values(KEEP)) expect(alphaOf(p, c)).toBe(1);
      expect(chromaKeyAlphaFactor(p, ...hex(KEY))).toBe(1);
    }
  });

  it('파란 키·빨간 키도 같은 규칙으로 동작한다 (초록 전용이 아니다)', () => {
    const blue = chromaKeyParams({ color: '#0047bb', similarity: 0.4, smoothness: 0.1 });
    expect(chromaKeyAlphaFactor(blue, ...hex('#0047bb'))).toBe(0);
    expect(chromaKeyAlphaFactor(blue, ...hex(KEEP.밝은피부))).toBe(1);
    expect(chromaKeyAlphaFactor(blue, ...hex(KEEP.흰옷))).toBe(1);
    const red = chromaKeyParams({ color: '#d62828', similarity: 0.4, smoothness: 0.1 });
    expect(chromaKeyAlphaFactor(red, ...hex('#d62828'))).toBe(0);
    expect(chromaKeyAlphaFactor(red, ...hex(KEEP.흰옷))).toBe(1);
    expect(chromaKeyAlphaFactor(red, ...hex(KEEP.하늘색옷))).toBe(1);
  });
});

describe('크로마키 SVG 체인', () => {
  const nodesFor = (spill?: number) =>
    buildFilterNodes([
      {
        kind: 'chromaKey',
        id: 'k',
        data: chromaKeyParams({ color: KEY, similarity: 0.4, smoothness: 0.1, ...(spill !== undefined ? { spill } : {}) }),
      },
    ]) as { type: string; props: Record<string, string> }[];

  it('디스필 포함 6개 primitive 가 q → e → d → r → in → in 으로 이어진다', () => {
    const n = nodesFor();
    expect(n.map((x) => x.type)).toEqual([
      'feColorMatrix', // kq: RGB = clamp01(m - t)
      'feColorMatrix', // ke: RGB = 0.5 + 0.5·q·v
      'feComposite', //   kd: in + 2·e - 1 = rgb + q·v
      'feColorMatrix', // kr: A = 램프
      'feComposite', //   kk: 디스필 RGB + 램프 알파
      'feComposite', //   k : × 입력 알파
    ]);
    expect(n.map((x) => x.props.result)).toEqual(['kq', 'ke', 'kd', 'kr', 'kk', 'k']);
    expect(n[0]!.props.in).toBe('SourceGraphic');
    expect(n[1]!.props.in).toBe('kq');
    expect(n[2]!.props.in).toBe('SourceGraphic');
    expect(n[2]!.props.in2).toBe('ke');
    expect(n[3]!.props.in).toBe('SourceGraphic');
    expect(n[4]!.props.in).toBe('kd');
    expect(n[4]!.props.in2).toBe('kr');
    // 마지막은 원본 알파를 다시 곱한다 — 없으면 미디어 바깥이 검게 칠해진다
    expect(n[5]!.props.in).toBe('kk');
    expect(n[5]!.props.in2).toBe('SourceGraphic');
    expect(n[5]!.props.operator).toBe('in');
  });

  it('spill=0 이면 디스필 3단계가 통째로 빠진다 (primitive 3개)', () => {
    const n = nodesFor(0);
    expect(n.map((x) => x.props.result)).toEqual(['kr', 'kk', 'k']);
    expect(n[1]!.props.in).toBe('SourceGraphic'); // 디스필 없이 원본 RGB 를 그대로 쓴다
  });

  it('알파 행이 램프 수식 그대로다 (feColorMatrix 한 줄)', () => {
    const p = chromaKeyParams({ color: KEY, similarity: 0.4, smoothness: 0.1 });
    const n = nodesFor();
    const rows = (n[3]!.props.values as string).split(' ').map(Number);
    expect(rows).toHaveLength(20);
    expect(rows.slice(0, 15).every((v) => v === 0)).toBe(true); // RGB 는 0
    expect(rows[15]!).toBeCloseTo(-p.c[0] / p.w, 3);
    expect(rows[16]!).toBeCloseTo(-p.c[1] / p.w, 3);
    expect(rows[17]!).toBeCloseTo(-p.c[2] / p.w, 3);
    expect(rows[18]!).toBe(0); // 입력 알파는 마지막 feComposite 에서 곱한다
    expect(rows[19]!).toBeCloseTo((p.t + p.w / 2) / p.w, 3);
    // 이 행에 픽셀 색을 넣으면 chromaKeyAlphaFactor 와 같은 값이 나온다
    for (const c of [KEY, ...Object.values(KEEP)]) {
      const [r, g, b] = hex(c);
      const raw = rows[15]! * r + rows[16]! * g + rows[17]! * b + rows[19]!;
      expect(Math.min(1, Math.max(0, raw))).toBeCloseTo(chromaKeyAlphaFactor(p, r, g, b), 3);
    }
  });

  it('디스필 행렬도 수식 그대로다 (q → 0.5 + 0.5·q·v, 합성은 in + 2·e - 1)', () => {
    const p = chromaKeyParams({ color: KEY, similarity: 0.4, smoothness: 0.1 });
    const n = nodesFor();
    const q = (n[0]!.props.values as string).split(' ').map(Number);
    expect(q.slice(0, 3)).toEqual(q.slice(5, 8)); // 세 채널이 같은 값
    expect(q[0]!).toBeCloseTo(p.c[0], 4);
    expect(q[4]!).toBeCloseTo(-p.t, 4);
    const e = (n[1]!.props.values as string).split(' ').map(Number);
    expect(e[0]!).toBeCloseTo(0.5 * p.v[0], 4);
    expect(e[6]!).toBeCloseTo(0.5 * p.v[1], 4);
    expect(e[12]!).toBeCloseTo(0.5 * p.v[2], 4);
    expect([e[4], e[9], e[14]]).toEqual([0.5, 0.5, 0.5]);
    const c = n[2]!.props as unknown as { k1: number; k2: number; k3: number; k4: number };
    expect([c.k1, c.k2, c.k3, c.k4]).toEqual([0, 1, 2, -1]);
    // e 채널값은 0..1 을 벗어나지 않는다 (벗어나면 필터 표면에서 잘려 디스필이 틀어진다)
    for (const s of [0, 0.5, 1]) {
      const pp = chromaKeyParams({ color: KEY, similarity: 0, smoothness: 0.1, spill: s });
      for (let i = 0; i < 3; i++) {
        expect(0.5 + 0.5 * Math.abs(pp.v[i]!) * 0.93).toBeLessThanOrEqual(1);
      }
    }
  });
});

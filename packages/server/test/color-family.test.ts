// F5 HSL 세컨더리 — «어느 픽셀이 어느 계열인가» 판정표를 실제 ffmpeg 픽셀로 검증한다.
//
// 계획 05 는 「판정 규칙을 추측으로 구현하지 말고, 표가 나오기 전까지 스포이드는 비활성」이라고 했다.
// 표는 libavfilter/vf_selectivecolor.c · vf_huesaturation.c 를 읽어서 만들었고(2026-09-02),
// **이 테스트가 그 표와 실제 필터가 한 픽셀도 안 어긋나는지 확인한다.** 그래서 스포이드를 켠다.
//
// (schema 는 순수 패키지라 ffmpeg 을 못 돌린다. server 는 schema·execa 를 둘 다 쓰므로 여기서 잰다.)
import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import {
  COLOR_PRESETS,
  HSL_FAMILIES,
  hslFamiliesOfRgb,
  hslFamilyOfRgb,
  hueSatBandsOfRgb,
  type HslFamily,
} from '@kitkat/schema';

const T = 120_000;

/** 검사용 픽셀 격자: r·g·b ∈ {0,16,...,255} 전 조합(4913) + 0..255 그레이 램프. */
function makeGrid(): { buf: Buffer; px: [number, number, number][] } {
  const steps = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255];
  const px: [number, number, number][] = [];
  for (const r of steps) for (const g of steps) for (const b of steps) px.push([r, g, b]);
  for (let v = 0; v <= 255; v++) px.push([v, v, v]);
  const buf = Buffer.alloc(px.length * 3);
  px.forEach(([r, g, b], i) => {
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  });
  return { buf, px };
}

/** 픽셀 버퍼를 rawvideo 로 필터에 통과시킨다 (인코딩·색공간 개입 없음). */
async function applyFilter(buf: Buffer, width: number, vf: string): Promise<Buffer> {
  const { stdout } = await execa(
    'ffmpeg',
    ['-hide_banner', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
     '-s', `${width}x1`, '-i', 'pipe:0', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { input: buf, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 },
  );
  return Buffer.from(stdout);
}

describe('selectivecolor 계열 판정표 (스포이드의 근거)', () => {
  it(
    '9계열 각각에 대해 «우리 규칙이 계열이 아니라고 한 픽셀» 은 한 개도 안 변한다',
    async () => {
      const { buf, px } = makeGrid();
      const report: string[] = [];
      for (const family of HSL_FAMILIES) {
        // k=-1 → 검정 잉크를 완전히 빼는 극단값. 계열에 «속하고 세기>0» 인 픽셀만 밝아진다.
        const out = await applyFilter(buf, px.length, `selectivecolor=correction_method=absolute:${family}=0 0 0 -1`);
        let changed = 0;
        let falsePositive = 0; // 우리는 «안 변한다» 했는데 변한 픽셀
        let falseNegative = 0; // 우리는 «변한다» 했는데 안 변한 픽셀
        px.forEach(([r, g, b], i) => {
          const same = out[i * 3] === r && out[i * 3 + 1] === g && out[i * 3 + 2] === b;
          if (!same) changed++;
          const match = hslFamiliesOfRgb(r, g, b).find((m) => m.family === family);
          // 예상 변화량: adjust_ch = lrint((1 - ch/255) · scale) — 소스의 comp_adjust 그대로
          const predicted = match
            ? [r, g, b].map((v) => Math.round((1 - v / 255) * match.scale))
            : [0, 0, 0];
          const willChange = predicted.some((d) => d !== 0);
          if (!willChange && !same) falsePositive++;
          // 반올림 경계(예상 변화량 1)는 lrintf 의 짝수 반올림과 갈릴 수 있으므로 2 이상만 본다
          if (willChange && same && Math.max(...predicted) >= 2) falseNegative++;
        });
        report.push(`${family}:${changed}`);
        expect(falsePositive, `${family} 오검출(우리 규칙 밖인데 변함)`).toBe(0);
        expect(falseNegative, `${family} 미검출(우리 규칙 안인데 안 변함)`).toBe(0);
      }
      console.log(`[F5 판정표] k=-1 로 밀었을 때 변한 픽셀 수 / 총 ${makeGrid().px.length} — ${report.join(' · ')}`);
    },
    T,
  );

  it(
    '변화량까지 소스 공식과 1레벨 이내로 같다 (세기 공식 검증)',
    async () => {
      const { buf, px } = makeGrid();
      for (const family of ['reds', 'yellows', 'whites', 'neutrals', 'blacks'] as HslFamily[]) {
        const out = await applyFilter(buf, px.length, `selectivecolor=correction_method=absolute:${family}=0 0 0 -1`);
        let worst = 0;
        px.forEach(([r, g, b], i) => {
          const match = hslFamiliesOfRgb(r, g, b).find((m) => m.family === family);
          const scale = match?.scale ?? 0;
          [r, g, b].forEach((v, c) => {
            const want = Math.min(255, Math.max(0, v + Math.round((1 - v / 255) * scale)));
            worst = Math.max(worst, Math.abs(out[i * 3 + c]! - want));
          });
        });
        expect(worst, `${family} 변화량 오차`).toBeLessThanOrEqual(1);
      }
    },
    T,
  );

  it(
    '회색은 색 계열로 못 만진다 — whites/neutrals/blacks 만 듣는다',
    async () => {
      const px: [number, number, number][] = [];
      for (let v = 0; v <= 255; v++) px.push([v, v, v]);
      const buf = Buffer.alloc(px.length * 3);
      px.forEach(([r], i) => {
        buf[i * 3] = r;
        buf[i * 3 + 1] = r;
        buf[i * 3 + 2] = r;
      });
      for (const family of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as HslFamily[]) {
        const out = await applyFilter(buf, px.length, `selectivecolor=correction_method=absolute:${family}=0 0 0 -1`);
        expect(out.equals(buf), `${family} 가 회색을 건드렸다`).toBe(true);
      }
      // 반대로 neutrals 는 «순수 검정·순수 흰색을 뺀» 회색 전부를 만진다
      const neutral = await applyFilter(buf, px.length, 'selectivecolor=correction_method=absolute:neutrals=0 0 0 -1');
      expect(neutral.equals(buf)).toBe(false);
      expect(neutral[0]).toBe(0); // 순수 검정은 is_neutral 조건에서 빠진다
      expect(neutral[255 * 3]).toBe(255); // 순수 흰색도
    },
    T,
  );

  it('hslFamilyOfRgb 는 색 계열을 밝기 계열보다 먼저 고른다', () => {
    expect(hslFamilyOfRgb(220, 160, 140)).toBe('reds');   // 밝은 피부톤
    expect(hslFamilyOfRgb(60, 110, 200)).toBe('blues');   // 하늘
    expect(hslFamilyOfRgb(120, 120, 120)).toBe('neutrals'); // 회색은 색 6계열 세기가 0
    expect(hslFamilyOfRgb(255, 255, 255)).toBe('whites');   // 순수 흰색은 whites 로만 만진다
    expect(hslFamilyOfRgb(0, 0, 0)).toBe('blacks');
  });

  it(
    '순수 흰색·검정도 잉크(CMY)로는 실제로 변한다 — 스포이드가 whites/blacks 를 가리키는 근거',
    async () => {
      const buf = Buffer.from([255, 255, 255, 0, 0, 0]);
      const white = await applyFilter(buf, 2, 'selectivecolor=correction_method=absolute:whites=0.2 0 0 0');
      expect(white[0]).toBeLessThan(255); // 시안 잉크가 빨강을 깎는다
      const black = await applyFilter(buf, 2, 'selectivecolor=correction_method=absolute:blacks=0 0 0 -0.2');
      expect(black[3]).toBeGreaterThan(0); // K 를 빼면 검정이 들린다
    },
    T,
  );
});

describe('huesaturation 6구간 판정 (같은 스포이드에서 쓴다)', () => {
  it(
    '우리 규칙이 «안 변한다» 한 픽셀은 실제로 안 변한다',
    async () => {
      const { buf, px } = makeGrid();
      for (const band of ['r', 'y', 'g', 'c', 'b', 'm'] as const) {
        const out = await applyFilter(
          buf, px.length,
          `huesaturation=colors=${band}:hue=60:saturation=0.5:intensity=0:strength=1:lightness=0`,
        );
        let falsePositive = 0;
        px.forEach(([r, g, b], i) => {
          const same = out[i * 3] === r && out[i * 3 + 1] === g && out[i * 3 + 2] === b;
          if (!same && !hueSatBandsOfRgb(r, g, b).includes(band)) falsePositive++;
        });
        expect(falsePositive, `${band} 구간 오검출`).toBe(0);
      }
    },
    T,
  );

  it(
    '회색(무채색)은 huesaturation 6구간으로 못 만진다',
    async () => {
      const px: number[] = [];
      for (let v = 0; v <= 255; v++) px.push(v);
      const buf = Buffer.alloc(px.length * 3);
      px.forEach((v, i) => {
        buf[i * 3] = v;
        buf[i * 3 + 1] = v;
        buf[i * 3 + 2] = v;
      });
      const out = await applyFilter(
        buf, px.length,
        'huesaturation=colors=r+y+g+c+b+m:hue=90:saturation=1:intensity=0:strength=1:lightness=0',
      );
      expect(out.equals(buf)).toBe(true);
      expect(hueSatBandsOfRgb(128, 128, 128)).toEqual([]);
    },
    T,
  );
});

describe('W7 실측 재현 — 계열 분리', () => {
  it(
    'selectivecolor=reds=0.35 0 -0.25 0 은 빨강만 바꾸고 나머지 5색은 정확히 0',
    async () => {
      // 컬러바의 6색 (SMPTE 순서와 같은 순수 원색/보색)
      const bars: [string, [number, number, number]][] = [
        ['빨강', [255, 0, 0]], ['초록', [0, 255, 0]], ['파랑', [0, 0, 255]],
        ['청록', [0, 255, 255]], ['자홍', [255, 0, 255]], ['노랑', [255, 255, 0]],
      ];
      const buf = Buffer.alloc(bars.length * 3);
      bars.forEach(([, [r, g, b]], i) => {
        buf[i * 3] = r;
        buf[i * 3 + 1] = g;
        buf[i * 3 + 2] = b;
      });
      const out = await applyFilter(buf, bars.length, 'selectivecolor=correction_method=absolute:reds=0.35 0 -0.25 0');
      const deltas = bars.map(([name, [r, g, b]], i) => {
        const d = Math.abs(out[i * 3]! - r) + Math.abs(out[i * 3 + 1]! - g) + Math.abs(out[i * 3 + 2]! - b);
        return `${name} ${d}`;
      });
      console.log(`[F5 계열 분리] ${deltas.join(' · ')}`);
      const redDelta = Math.abs(out[0]! - 255) + Math.abs(out[1]!) + Math.abs(out[2]!);
      expect(redDelta).toBeGreaterThan(100);
      for (let i = 1; i < bars.length; i++) {
        const [, [r, g, b]] = bars[i]!;
        expect(out[i * 3]).toBe(r);
        expect(out[i * 3 + 1]).toBe(g);
        expect(out[i * 3 + 2]).toBe(b);
      }
    },
    T,
  );
});

describe('피부톤 프리셋 — 피부만 변하고 배경은 안 변하는가', () => {
  it(
    '「붉은기 빼기」는 피부 패치만 바꾸고 하늘·잔디·회색은 한 레벨도 안 바꾼다',
    async () => {
      // Macbeth 차트의 피부 패치 2종 + 배경색들
      const patches: [string, [number, number, number], boolean][] = [
        ['밝은 피부', [240, 208, 192], true],
        ['어두운 피부', [115, 82, 68], true],
        ['하늘', [96, 140, 200], false],
        ['잔디', [90, 148, 88], false],
        ['중간 회색', [128, 128, 128], false],
        ['청록 소품', [60, 180, 180], false],
      ];
      const buf = Buffer.alloc(patches.length * 3);
      patches.forEach(([, [r, g, b]], i) => {
        buf[i * 3] = r;
        buf[i * 3 + 1] = g;
        buf[i * 3 + 2] = b;
      });
      const preset = COLOR_PRESETS.find((p) => p.id === 'skin-less-red')!;
      const ink = preset.hsl![0]!;
      const vf = `selectivecolor=correction_method=absolute:${ink.family}=${ink.cyan} ${ink.magenta} ${ink.yellow} ${ink.black}`;
      const out = await applyFilter(buf, patches.length, vf);
      const lines = patches.map(([name, [r, g, b]], i) => {
        const d = [out[i * 3]! - r, out[i * 3 + 1]! - g, out[i * 3 + 2]! - b];
        return `${name} (${d.join(',')})`;
      });
      console.log(`[F5 피부톤 격리] ${lines.join(' · ')}`);
      patches.forEach(([name, [r, g, b], shouldChange], i) => {
        const changed = out[i * 3] !== r || out[i * 3 + 1] !== g || out[i * 3 + 2] !== b;
        expect(changed, `${name} 변화 여부`).toBe(shouldChange);
      });
      // 방향도 맞아야 한다 — 시안↑ 자홍↓ 은 빨강을 낮추고 초록을 올린다
      expect(out[0]!).toBeLessThan(patches[0]![1][0]);
      expect(out[1]!).toBeGreaterThan(patches[0]![1][1]);
    },
    T,
  );

  it(
    '「피부 채도 낮추기」(huesaturation)는 빨강·노랑 구간만 건드린다',
    async () => {
      const patches: [string, [number, number, number], boolean][] = [
        ['밝은 피부', [240, 208, 192], true],
        ['어두운 피부', [115, 82, 68], true],
        ['하늘', [96, 140, 200], false],
        ['잔디', [90, 148, 88], false],
        ['중간 회색', [128, 128, 128], false],
      ];
      const buf = Buffer.alloc(patches.length * 3);
      patches.forEach(([, [r, g, b]], i) => {
        buf[i * 3] = r;
        buf[i * 3 + 1] = g;
        buf[i * 3 + 2] = b;
      });
      const preset = COLOR_PRESETS.find((p) => p.id === 'skin-desaturate')!;
      const band = preset.hueSat![0]!;
      const vf =
        `huesaturation=colors=${band.bands.join('+')}:hue=${band.hue}` +
        `:saturation=${band.saturation}:intensity=${band.intensity}:strength=1:lightness=0`;
      const out = await applyFilter(buf, patches.length, vf);
      patches.forEach(([name, [r, g, b], shouldChange], i) => {
        const changed = out[i * 3] !== r || out[i * 3 + 1] !== g || out[i * 3 + 2] !== b;
        expect(changed, `${name} 변화 여부`).toBe(shouldChange);
      });
    },
    T,
  );
});

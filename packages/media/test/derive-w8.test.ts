// W8 S3 — ClipSource 확장의 실제 ffmpeg 검증.
// 「돌아간다」가 아니라 «숫자» 로 낸다: 필터 순서가 픽셀을 바꾸는지, alimiter 가 몰래
// +1.0dB 를 붙이는지, 2패스 loudnorm 이 목표 LUFS 에 앉는지.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  deriveMedia,
  estimateMotionBlurSeconds,
  loudnessLra,
  matchColorLevels,
  videoFilterChain,
  voiceChain,
  voiceLra,
  MUSIC_LRA,
  type DeriveSpec,
  type MatchLevels,
} from '../src/derive.js';
import { ffprobeJson } from '../src/ffmpeg.js';

const T = 120_000;
const T5 = 300_000;

let srcDir: string;
let outDir: string;
let vid: string;       // 1초 320x180 30fps + sine
let tiny: string;      // 1초 160x120 30fps (precise 모션 블러용 — 8배 보간이라 작아야 한다)
let narration: string; // 4초, 다이내믹이 있는 «말소리 비슷한» 신호
let quietTone: string; // -38dB 사인 — alimiter 자동 레벨링 함정 재현용
let cubeAbs: string;   // 비항등 LUT (따뜻한 룩)

const stat = (mean: number, std: number) => ({ mean, std });

/** W7 실측(계획 04)에 가까운 통계 쌍 — 「따뜻·밝음」 기준 vs 「차갑·어두움」 대상. */
const LEVELS: MatchLevels = {
  sampledAtMs: [50, 250, 500, 750, 950],
  refSourceKey: 'raw',
  ref: [stat(119.3 / 255, 117.5 / 255), stat(131.9 / 255, 120.3 / 255), stat(126.8 / 255, 126.3 / 255)],
  target: [stat(103.7 / 255, 102.0 / 255), stat(93.0 / 255, 89.2 / 255), stat(71.3 / 255, 66.1 / 255)],
};

/** 비항등 3D LUT (빨강 올리고 파랑 내리는 「따뜻한 룩」). */
function warmCube(size: number): string {
  const n = size - 1;
  const lines = [`LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        lines.push(
          `${Math.min(1, (r / n) ** 0.75).toFixed(6)} ${(g / n).toFixed(6)} ${Math.min(1, (b / n) ** 1.3).toFixed(6)}`,
        );
      }
    }
  }
  return lines.join('\n') + '\n';
}

/** 두 이미지의 PSNR(dB). 완전히 같으면 Infinity. */
async function psnr(a: string, b: string): Promise<number> {
  const r = await execa('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], {
    reject: false,
  });
  const m = /average:([\d.]+|inf)/.exec(String(r.stderr));
  if (!m) throw new Error(`psnr 파싱 실패: ${String(r.stderr).slice(-300)}`);
  return m[1] === 'inf' ? Infinity : Number(m[1]);
}

/** volumedetect 의 mean/max (dB). */
async function volume(file: string, pre = 'anull'): Promise<{ mean: number; max: number }> {
  const r = await execa('ffmpeg', ['-hide_banner', '-i', file, '-af', `${pre},volumedetect`, '-f', 'null', '-'], {
    reject: false,
  });
  const s = String(r.stderr);
  const mean = Number(/mean_volume: ([-\d.]+) dB/.exec(s)?.[1]);
  const max = Number(/max_volume: ([-\d.]+) dB/.exec(s)?.[1]);
  return { mean, max };
}

/** loudnorm 1패스로 파일의 실제 통합 라우드니스(LUFS)·트루피크를 잰다. */
async function loudness(file: string): Promise<{ lufs: number; tp: number; lra: number }> {
  const d = await mkdtemp(path.join(tmpdir(), 'ln-'));
  try {
    await execa(
      'ffmpeg',
      ['-hide_banner', '-v', 'error', '-i', file, '-af',
        'loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json:stats_file=m.json', '-f', 'null', '-'],
      { cwd: d },
    );
    const j = JSON.parse(await readFile(path.join(d, 'm.json'), 'utf8')) as Record<string, string>;
    return { lufs: Number(j.input_i), tp: Number(j.input_tp), lra: Number(j.input_lra) };
  } finally {
    await rm(d, { recursive: true, force: true });
  }
}

/** 필터 체인 하나를 걸어 PNG 한 장을 굽는다 (컬러바 + 그레이 램프). */
async function bakeFrame(cwd: string, name: string, chain: string[]): Promise<string> {
  const out = path.join(cwd, name);
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=1:duration=1', '-frames:v', '1'];
  if (chain.length > 0) args.push('-vf', chain.join(','));
  args.push('-pix_fmt', 'rgb24', out);
  await execa('ffmpeg', args, { cwd });
  return out;
}

beforeAll(async () => {
  srcDir = await mkdtemp(path.join(tmpdir(), 'kk-w8-src-'));
  outDir = await mkdtemp(path.join(tmpdir(), 'kk-w8-out-'));
  vid = path.join(srcDir, 'v.mp4');
  tiny = path.join(srcDir, 'tiny.mp4');
  narration = path.join(srcDir, 'n.wav');
  quietTone = path.join(srcDir, 'q.wav');
  cubeAbs = path.join(srcDir, 'warm.cube');
  await writeFile(cubeAbs, warmCube(8));

  await execa('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', vid,
  ]);
  await execa('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=1',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', tiny,
  ]);
  // 다이내믹이 있는 신호(트레몰로 건 핑크 노이즈) — 순수 사인은 LRA 0 이라 loudnorm 이
  // 무조건 dynamic 으로 떨어져서 「목표에 앉는지」를 제대로 못 본다
  await execa('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=4:amplitude=0.25:seed=7',
    '-af', 'tremolo=f=0.4:d=0.9,volume=-8dB',
    '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', narration,
  ]);
  await execa('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3',
    '-af', 'volume=-38dB', '-ar', '48000', '-c:a', 'pcm_s16le', quietTone,
  ]);
}, T);

afterAll(async () => {
  await rm(srcDir, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
});

// ── 필터 순서 (S3 계약의 핵심) ───────────────────────────────────────────

describe('필터 순서 — 고정의 근거', () => {
  const spec: DeriveSpec = {
    matchTo: { levels: LEVELS, strength: 1 },
    hueSat: [{ id: 'h', bands: ['r', 'y'], hue: 12, saturation: 0.3, intensity: 0 }],
    hsl: [{ id: 's', family: 'reds', cyan: 0.35, magenta: 0, yellow: -0.25, black: 0 }],
    lut: { cubeAbs: 'x', intensity: 1 },
    motionBlur: { shutterAngle: 180, quality: 'fast' },
  };

  it('videoFilterChain 이 matchTo → hueSat → hsl → lut → motionBlur 순서를 낸다', () => {
    const chain = videoFilterChain(spec);
    expect(chain.map((f) => f.split('=')[0])).toEqual([
      'colorlevels', 'huesaturation', 'selectivecolor', 'lut3d', 'tmix',
    ]);
  });

  it('matchTo 를 LUT «뒤» 로 옮기면 픽셀이 달라진다 — 룩보다 색 맞추기가 먼저여야 하는 이유', async () => {
    const d = await mkdtemp(path.join(tmpdir(), 'ord1-'));
    try {
      await writeFile(path.join(d, 'lut.cube'), warmCube(8));
      const chain = videoFilterChain({ matchTo: { levels: LEVELS, strength: 1 }, lut: { cubeAbs: 'x', intensity: 1 } });
      expect(chain).toHaveLength(2);
      const a = await bakeFrame(d, 'a.png', chain);
      const b = await bakeFrame(d, 'b.png', [...chain].reverse());
      const p = await psnr(a, b);
      // 같으면 Infinity — 다르다는 것을 «수치로» 확인해야 순서 고정이 근거 있는 결정이 된다
      expect(p).toBeLessThan(60);
      expect(await psnr(a, a)).toBe(Infinity);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  }, T);

  it('hueSat(primary) 과 hsl(secondary) 의 순서를 바꾸면 픽셀이 달라진다', async () => {
    const d = await mkdtemp(path.join(tmpdir(), 'ord2-'));
    try {
      const chain = videoFilterChain({
        hueSat: [{ id: 'h', bands: ['r', 'y'], hue: 12, saturation: 0.3, intensity: 0 }],
        hsl: [{ id: 's', family: 'reds', cyan: 0.35, magenta: 0, yellow: -0.25, black: 0 }],
      });
      expect(chain).toHaveLength(2);
      const a = await bakeFrame(d, 'a.png', chain);
      const b = await bakeFrame(d, 'b.png', [...chain].reverse());
      expect(await psnr(a, b)).toBeLessThan(60);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  }, T);

  it('W7 실측 재현 — selectivecolor=reds 는 빨강만 바꾸고 나머지 5색은 «정확히 0»', async () => {
    // 순색 한 장씩에 걸어 RGB 를 직접 읽는다. 계열 분리가 안 되면 이 기능의 전제가 무너진다.
    const chain = videoFilterChain({
      hsl: [{ id: 's', family: 'reds', cyan: 0.35, magenta: 0, yellow: -0.25, black: 0 }],
    }).join(',');
    const px = async (hex: string, vf?: string): Promise<[number, number, number]> => {
      const args = ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${hex}:s=8x8:d=1`, '-frames:v', '1'];
      if (vf) args.push('-vf', vf);
      args.push('-pix_fmt', 'rgb24', '-f', 'rawvideo', '-');
      const b = Buffer.from((await execa('ffmpeg', args, { encoding: 'buffer' })).stdout);
      return [b[0]!, b[1]!, b[2]!];
    };
    const delta = async (hex: string) => {
      const [a, b] = [await px(hex), await px(hex, chain)];
      return Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
    };
    expect(await delta('0xff0000')).toBeGreaterThan(50);   // 실측 89 (253,0,0 → 164,0,63)
    for (const other of ['0x00ff00', '0x0000ff', '0x00ffff', '0xff00ff', '0xffff00']) {
      expect(await delta(other)).toBe(0);                   // 나머지 5색은 한 톨도 안 변한다
    }
  }, T);
});

// ── colorlevels 역산 ─────────────────────────────────────────────────────

describe('matchColorLevels', () => {
  it('강도 0 은 완전한 항등 사상 (원본과 픽셀이 같아야 한다)', () => {
    const f = matchColorLevels(LEVELS, 0);
    expect(f).toContain('rimin=0');
    expect(f).toContain('rimax=1');
    expect(f).toContain('romin=0');
    expect(f).toContain('romax=1');
  });

  it('preserve=none 을 명시한다 (lum 은 밝기를 보존해 컷 맞추기를 망친다)', () => {
    expect(matchColorLevels(LEVELS, 1)).toContain('preserve=none');
  });

  it('강도가 선형이다 — s=0.5 의 «사상» 이 s=0·s=1 의 정확한 중간', () => {
    // 계획 04 의 주장은 «사상» 에 대한 것이다: (1−s)·in + s·(a·in+b) = (1+(a−1)s)·in + s·b.
    // 클리핑된 출력값으로 재면 0·1 에 붙는 구간 때문에 당연히 안 맞는다 — 직선의 계수로 잰다.
    const coeff = (s: number, ch: 'r' | 'g' | 'b') => {
      const re = new RegExp(`${ch}imin=([-\\d.]+):${ch}imax=([-\\d.]+):${ch}omin=([-\\d.]+):${ch}omax=([-\\d.]+)`);
      const m = re.exec(matchColorLevels(LEVELS, s))!;
      const [imin, imax, omin, omax] = m.slice(1).map(Number) as [number, number, number, number];
      const a = (omax - omin) / (imax - imin);
      return { a, b: omin - a * imin };
    };
    for (const ch of ['r', 'g', 'b'] as const) {
      const c0 = coeff(0, ch);
      const c5 = coeff(0.5, ch);
      const c1 = coeff(1, ch);
      expect(c0.a).toBeCloseTo(1, 5);   // s=0 은 항등 사상
      expect(c0.b).toBeCloseTo(0, 5);
      expect(c5.a).toBeCloseTo((c0.a + c1.a) / 2, 4);   // 진짜로 «절반만 맞추기»
      expect(c5.b).toBeCloseTo((c0.b + c1.b) / 2, 4);
    }
  });

  it('a = σ_ref/σ_target = 0.3 도 «정확히» 표현된다 (계획 04 의 「0.5 미만이면 불가」는 사실이 아니다)', () => {
    const L: MatchLevels = {
      sampledAtMs: [0], refSourceKey: 'raw',
      ref: [stat(0.5, 0.06), stat(0.5, 0.06), stat(0.5, 0.06)],
      target: [stat(0.5, 0.2), stat(0.5, 0.2), stat(0.5, 0.2)],
    };
    const m = /rimin=([-\d.]+):rimax=([-\d.]+):romin=([-\d.]+):romax=([-\d.]+)/.exec(matchColorLevels(L, 1))!;
    const [imin, imax, omin, omax] = m.slice(1).map(Number) as [number, number, number, number];
    const slope = (omax - omin) / (imax - imin);
    expect(slope).toBeCloseTo(0.3, 6); // 클램프 뒤에도 기울기가 a 로 남는다
  });

  it('퇴화 입력(완전 검정 기준 + 완전 흰 대상)은 조용히 클램프하지 않고 실패시키며 가능한 강도를 알려준다', () => {
    const L: MatchLevels = {
      sampledAtMs: [0], refSourceKey: 'raw',
      ref: [stat(0, 0.001), stat(0, 0.001), stat(0, 0.001)],
      target: [stat(1, 0.3), stat(1, 0.3), stat(1, 0.3)],
    };
    expect(() => matchColorLevels(L, 1)).toThrow(/강도를 \d+% 이하로 낮추면/);
  });

  it('σ_target 이 0 이어도 NaN 을 내지 않는다 (평균만 옮긴다)', () => {
    const L: MatchLevels = {
      sampledAtMs: [0], refSourceKey: 'raw',
      ref: [stat(0.6, 0.2), stat(0.6, 0.2), stat(0.6, 0.2)],
      target: [stat(0.4, 0), stat(0.4, 0), stat(0.4, 0)],
    };
    expect(matchColorLevels(L, 1)).not.toMatch(/NaN|Infinity/);
  });
});

// ── 오디오: alimiter 함정 + 2패스 loudnorm ───────────────────────────────

describe('voiceChain — alimiter 자동 레벨링 함정', () => {
  it('alimiter 기본값(level=true)은 리미터에 닿지도 않은 신호에 +1.0dB 를 붙인다', async () => {
    const raw = await volume(quietTone);
    const auto = await volume(quietTone, 'alimiter=limit=0.891');
    const off = await volume(quietTone, 'alimiter=limit=0.891:level=false');
    // 함정이 진짜인지부터 확인한다 — 확인 못 한 것을 근거로 쓰지 않는다
    expect(auto.max - raw.max).toBeGreaterThan(0.9);
    expect(auto.max - raw.max).toBeLessThan(1.1);
    // level=false 면 한 톨도 안 붙는다
    expect(off.max).toBeCloseTo(raw.max, 5);
    expect(off.mean).toBeCloseTo(raw.mean, 5);
  }, T);

  it('우리 체인은 반드시 level=false·latency=true 를 쓴다', () => {
    for (const p of ['broadcast', 'warm', 'bright', 'podcast'] as const) {
      const c = voiceChain(p);
      expect(c).toContain('level=false');
      expect(c).toContain('latency=true');
      expect(c).not.toMatch(/level=true/);
    }
  });

  it('디에서가 컴프 «앞» 이다 (뒤에 두면 컴프가 치찰음 피크에 반응해 문장 전체를 눌렀다 놓는다)', () => {
    const c = voiceChain('broadcast');
    expect(c.indexOf('deesser')).toBeGreaterThan(-1);
    expect(c.indexOf('deesser')).toBeLessThan(c.indexOf('acompressor'));
    expect(c.indexOf('acompressor')).toBeLessThan(c.indexOf('alimiter'));
  });

  it('10kHz 는 하이셸프다 — 계획 11 이 적은 equalizer=t=h:w=0.7 은 0.0dB 무동작이었다', async () => {
    const d = await mkdtemp(path.join(tmpdir(), 'shelf-'));
    try {
      const noise = path.join(d, 'n.wav');
      await execa('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
        '-i', 'anoisesrc=color=white:duration=3:amplitude=0.2:seed=3', '-ar', '48000', '-c:a', 'pcm_s16le', noise]);
      const base = (await volume(noise, 'highpass=f=9000')).mean;
      const planText = (await volume(noise, 'equalizer=f=10000:t=h:w=0.7:g=2,highpass=f=9000')).mean;
      const ours = (await volume(noise, 'highshelf=f=10000:t=q:w=0.7:g=2,highpass=f=9000')).mean;
      expect(planText - base).toBeLessThan(0.1);      // 계획서 문자열: 아무 일도 안 일어난다
      expect(ours - base).toBeGreaterThan(1);          // 하이셸프: 실제로 고역이 오른다
      expect(voiceChain('broadcast')).toContain('highshelf=f=10000');
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  }, T);

  it('프리셋 4종이 실제로 다른 인자를 낸다', () => {
    const set = new Set(['broadcast', 'warm', 'bright', 'podcast'].map((p) => voiceChain(p as 'warm')));
    expect(set.size).toBe(4);
    expect(voiceChain('warm')).toContain('equalizer=f=200:t=q:w=1.0:g=1.5');   // warm 만 200Hz 를 «올린다»
    expect(voiceChain('broadcast')).toContain('equalizer=f=200:t=q:w=1.0:g=-3');
    expect(voiceLra('podcast')).toBe(7);   // podcast 만 다이내믹을 좁힌다
    expect(voiceLra('broadcast')).toBe(11);
  });
});

describe('loudnessLra — 음악에 목소리용 LRA 를 쓰면 안 된다', () => {
  it('voice 가 있으면 프리셋 LRA 를 쓴다 — 컴프가 이미 폭을 좁혔으므로', () => {
    expect(loudnessLra({ voice: { preset: 'broadcast' }, loudness: { targetLufs: -14 } })).toBe(11);
    expect(loudnessLra({ voice: { preset: 'podcast' }, loudness: { targetLufs: -14 } })).toBe(7);
  });

  it('voice 가 없으면 음악용 20 — 좁게 주면 loudnorm 이 동적 모드로 바뀌어 곡을 평평하게 만든다', () => {
    expect(loudnessLra({ loudness: { targetLufs: -24 } })).toBe(MUSIC_LRA);
    expect(MUSIC_LRA).toBe(20);
  });
});

describe('2패스 loudnorm', () => {
  it('audio 클립: 목표 -14 LUFS 에 ±0.5 안으로 앉고, 트루피크가 -1.0 dBTP 를 안 넘는다', async () => {
    const before = await loudness(narration);
    const r = await deriveMedia(narration, outDir, 'ln1', 'k1', {
      voice: { preset: 'broadcast' }, loudness: { targetLufs: -14 },
    }, { audioOnly: true });
    const after = await loudness(path.join(outDir, r.src));
    expect(before.lufs).toBeLessThan(-16);            // 출발점이 목표와 떨어져 있어야 의미가 있다
    expect(Math.abs(after.lufs - -14)).toBeLessThanOrEqual(0.5);
    expect(after.tp).toBeLessThanOrEqual(-1.0 + 0.5);
    expect(r.loudnorm?.normalization_type).toMatch(/^(linear|dynamic)$/);
  }, T5);

  it('다른 목표(-20 LUFS)도 그 값에 앉는다 (목표를 몰래 바꾸지 않는다)', async () => {
    const r = await deriveMedia(narration, outDir, 'ln2', 'k2', {
      voice: { preset: 'podcast' }, loudness: { targetLufs: -20 },
    }, { audioOnly: true });
    const after = await loudness(path.join(outDir, r.src));
    expect(Math.abs(after.lufs - -20)).toBeLessThanOrEqual(0.5);
  }, T5);

  it('1패스 loudnorm 보다 정확하다 — 2패스를 쓰는 이유 (같은 조건, 둘 다 wav)', async () => {
    // 코덱을 섞으면 비교가 안 된다 — 2패스만 aac 로 굽고 1패스는 wav 로 재면
    // 손실 압축 오차(±0.2dB)가 결과를 뒤집는다. 둘 다 wav 로 맞춘다.
    const d = await mkdtemp(path.join(tmpdir(), 'ln1p-'));
    try {
      const chain = voiceChain('broadcast');
      const target = 'I=-14:TP=-1.0:LRA=11';
      const onePass = path.join(d, 'one.wav');
      await execa('ffmpeg', ['-y', '-v', 'error', '-i', narration,
        '-af', `${chain},loudnorm=${target}`, '-ar', '48000', onePass]);

      await execa('ffmpeg', ['-v', 'error', '-i', narration,
        '-af', `${chain},loudnorm=${target}:print_format=json:stats_file=s.json`, '-f', 'null', '-'], { cwd: d });
      const m = JSON.parse(await readFile(path.join(d, 's.json'), 'utf8')) as Record<string, string>;
      const twoPass = path.join(d, 'two.wav');
      await execa('ffmpeg', ['-y', '-v', 'error', '-i', narration,
        '-af', `${chain},loudnorm=${target}:measured_I=${m.input_i}:measured_LRA=${m.input_lra}` +
          `:measured_TP=${m.input_tp}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`,
        '-ar', '48000', twoPass]);

      const one = Math.abs((await loudness(onePass)).lufs + 14);
      const two = Math.abs((await loudness(twoPass)).lufs + 14);
      expect(two).toBeLessThan(one);          // 실측: 2패스 0.01 vs 1패스 0.15 (15배)
      expect(two).toBeLessThanOrEqual(0.1);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  }, T5);

  it('출력 샘플레이트가 48000 이다 — 안 적으면 loudnorm 이 192kHz 로 뱉는다', async () => {
    const r = await deriveMedia(narration, outDir, 'ar1', 'k4', {
      voice: { preset: 'warm' }, loudness: { targetLufs: -14 },
    }, { audioOnly: true });
    const info = await ffprobeJson(path.join(outDir, r.src));
    const a = (info.streams ?? []).find((s) => s.codec_type === 'audio') as { sample_rate?: string } | undefined;
    expect(a?.sample_rate).toBe('48000');
  }, T5);

  it('함정 확인 — -ar 을 빼면 실제로 192000 이 나온다', async () => {
    const d = await mkdtemp(path.join(tmpdir(), 'noar-'));
    try {
      const out = path.join(d, 'x.wav');
      await execa('ffmpeg', ['-y', '-v', 'error', '-i', narration,
        '-af', 'loudnorm=I=-14:TP=-1.0:LRA=11', out]);
      const info = await ffprobeJson(out);
      const a = (info.streams ?? []).find((s) => s.codec_type === 'audio') as { sample_rate?: string } | undefined;
      expect(a?.sample_rate).toBe('192000');
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  }, T);

  it('파생 파일 길이가 소스와 ±150ms 안이다 (편집이 어긋나면 안 된다)', async () => {
    const r = await deriveMedia(narration, outDir, 'len1', 'k5', {
      voice: { preset: 'bright' }, loudness: { targetLufs: -14 },
    }, { audioOnly: true });
    const info = await ffprobeJson(path.join(outDir, r.src));
    expect(Math.abs(Number(info.format?.duration) * 1000 - 4000)).toBeLessThanOrEqual(150);
  }, T5);
});

// ── deriveMedia: 새 필드 각각이 실제로 파일을 만든다 ─────────────────────

describe('deriveMedia — W8 S3 필드', () => {
  const check = async (assetId: string, key: string, spec: DeriveSpec) => {
    const progress: number[] = [];
    const r = await deriveMedia(vid, outDir, assetId, key, spec, { onProgress: (p) => progress.push(p) });
    expect(r.src).toBe(`derived/${assetId}.${key}.mp4`);
    // 리뷰 #3 — 파생 프록시도 원본 프록시와 같은 판 표시(.g15)를 단다
    expect(r.proxySrc).toBe(`derived/${assetId}.${key}.p.g15.mp4`);
    const info = await ffprobeJson(path.join(outDir, r.src));
    expect((info.streams ?? []).some((s) => s.codec_type === 'video')).toBe(true);
    // 가변 패스 수 — 진행률은 단조 증가하고 마지막은 정확히 1
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]! - 1e-9);
    return { r, info };
  };

  it('hueSat → huesaturation 한 패스', async () => {
    await check('w1', 'khuesat', { hueSat: [{ id: 'h', bands: ['r', 'y'], hue: 10, saturation: -0.15, intensity: 0 }] });
  }, T5);

  it('hsl → selectivecolor 한 패스', async () => {
    await check('w2', 'khsl', { hsl: [{ id: 's', family: 'reds', cyan: 0.06, magenta: -0.05, yellow: 0, black: 0 }] });
  }, T5);

  it('matchTo → colorlevels 한 패스', async () => {
    await check('w3', 'kmatch', { matchTo: { levels: LEVELS, strength: 1 } });
  }, T5);

  it('motionBlur fast → tmix', async () => {
    await check('w4', 'kmbfast', { motionBlur: { shutterAngle: 180, quality: 'fast' } });
  }, T5);

  it('voice → 오디오·비디오 유지 + 48kHz + loudnorm 통계 반환', async () => {
    const { r, info } = await check('w5', 'kvoice', {
      voice: { preset: 'broadcast' }, loudness: { targetLufs: -14 },
    });
    const a = (info.streams ?? []).find((s) => s.codec_type === 'audio') as { sample_rate?: string } | undefined;
    expect(a?.sample_rate).toBe('48000');
    expect(r.loudnorm?.normalization_type).toBeDefined();
  }, T5);

  it('loudness 만 (voice 없이) → loudnorm 2패스가 돈다 — 이번에 고치는 핵심', async () => {
    const { r, info } = await check('w6', 'kloud', { loudness: { targetLufs: -20 } });
    const a = (info.streams ?? []).find((s) => s.codec_type === 'audio') as { sample_rate?: string } | undefined;
    // loudnorm 은 트루피크 검출로 192kHz 로 업샘플한다 — 48000 이면 -ar 이 걸렸다는 뜻
    expect(a?.sample_rate).toBe('48000');
    expect(r.loudnorm?.normalization_type).toMatch(/^(linear|dynamic)$/);
  }, T5);

  it('voice 만 (loudness 없이) → 음색만 바뀌고 loudnorm 통계가 «없다»', async () => {
    const r = await deriveMedia(vid, outDir, 'w7', 'kvonly', { voice: { preset: 'warm' } });
    expect(r.src).toBe('derived/w7.kvonly.mp4');
    expect(r.loudnorm).toBeUndefined();
  }, T5);

  it('색보정 5종 + LUT 을 한꺼번에 걸어도 한 패스다 (LUT 부분강도 = filter_complex 경로)', async () => {
    await check('w6', 'kall', {
      matchTo: { levels: LEVELS, strength: 0.7 },
      hueSat: [{ id: 'h', bands: ['g'], hue: -5, saturation: 0.1, intensity: 0 }],
      hsl: [{ id: 's', family: 'blues', cyan: 0.1, magenta: 0.04, yellow: 0, black: 0.05 }],
      lut: { cubeAbs, intensity: 0.5 },
      motionBlur: { shutterAngle: 90, quality: 'fast' },
    });
  }, T5);

  it('motionBlur precise → minterpolate 8배 + tmix (기본값은 precise 다 — 느려도 안 바꾼다)', async () => {
    const r = await deriveMedia(tiny, outDir, 'w7', 'kmbprec', {
      motionBlur: { shutterAngle: 180, quality: 'precise' },
    });
    const info = await ffprobeJson(path.join(outDir, r.src));
    const v = (info.streams ?? []).find((s) => s.codec_type === 'video');
    expect(v?.avg_frame_rate).toBe('30/1');   // 8배로 올렸다가 원래 fps 로 되돌아온다
    expect(Math.abs(Number(info.format?.duration) * 1000 - 1000)).toBeLessThanOrEqual(150);
  }, T5);

  it('빈 spec 은 여전히 throw (새 필드가 빈 배열이어도)', async () => {
    await expect(deriveMedia(vid, outDir, 'w8', 'kempty', { hsl: [], hueSat: [] })).rejects.toThrow('빈 파생 스펙');
  }, T);
});

describe('estimateMotionBlurSeconds', () => {
  it('계획 03 실측 재현 — 1080×1920 1초 precise = 77초, fast = 0.8초', () => {
    const info = { durationMs: 1000, width: 1080, height: 1920 };
    expect(estimateMotionBlurSeconds({ shutterAngle: 180, quality: 'precise' }, info)).toBe(77);
    expect(estimateMotionBlurSeconds({ shutterAngle: 180, quality: 'fast' }, info)).toBe(1);
  });

  it('30초 광고면 precise 는 38분이 넘는다 — 몰래 돌리지 말고 이 숫자를 보여준다', () => {
    const sec = estimateMotionBlurSeconds(
      { shutterAngle: 180, quality: 'precise' },
      { durationMs: 30_000, width: 1080, height: 1920 },
    );
    expect(sec).toBe(2310);
    expect(sec / 60).toBeGreaterThan(38);
  });

  it('픽셀 수에 비례한다 (540p 세로는 1/4)', () => {
    expect(estimateMotionBlurSeconds({ shutterAngle: 180, quality: 'precise' }, { durationMs: 1000, width: 540, height: 960 }))
      .toBe(19);
  });

  it('셔터 각도가 0이면 섞을 게 없어 0초', () => {
    expect(estimateMotionBlurSeconds({ shutterAngle: 0, quality: 'precise' }, { durationMs: 30_000, width: 1080, height: 1920 })).toBe(0);
    expect(videoFilterChain({ motionBlur: { shutterAngle: 0, quality: 'fast' } })).toEqual([]);
  });
});

// W8 F17 — 파생 프록시도 makeProxy 와 같은 키프레임 간격이어야 한다.
// F14 가 makeProxy 에만 -g 15 를 넣어서, 파생 미디어를 쓰는 클립만 스크럽이 느렸다.
describe('deriveMedia 프록시 — 키프레임 간격', () => {
  it('파생 프록시에도 0.5초마다 키프레임이 있다 (-g 15)', async () => {
    const r = await deriveMedia(vid, outDir, 'gop1', 'kgop', {
      hueSat: [{ id: 'h', bands: ['r'], hue: 5, saturation: 0, intensity: 0 }],
    });
    expect(r.proxySrc).toBeDefined();
    const { stdout } = await execa('ffprobe', [
      '-v', 'error', '-select_streams', 'v',
      '-show_entries', 'frame=key_frame', '-of', 'csv=p=0',
      path.join(outDir, r.proxySrc!),
    ]);
    const flags = stdout.trim().split(String.fromCharCode(10));
    const keys = flags.filter((f) => f.startsWith('1')).length;
    expect(flags.length).toBeGreaterThan(0);
    expect(keys).toBeGreaterThanOrEqual(Math.floor(flags.length / 15));
  }, T5);
});

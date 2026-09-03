// F6 정밀 스코프 — 스틸 한 장에 ffmpeg 스코프 필터를 걸어 PNG 로 굽는다.
//
// 실시간 스코프(브라우저 WebGL)와 달리 이쪽은 **최종 렌더와 같은 픽셀**을 본다.
// 미리보기는 540p 프록시에 일부 효과를 근사하므로, 색을 «수치로» 판정하려면 이 경로여야 한다.
//
// 필터 문자열은 2026-09-02 에 실행으로 확인한 것 그대로다. 바꾸면 다시 확인할 것.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runFfmpeg, runFfmpegBuffer } from './ffmpeg.js';

export type ScopeKind = 'waveform' | 'vectorscope' | 'histogram';

export const SCOPE_KINDS: readonly ScopeKind[] = ['waveform', 'vectorscope', 'histogram'];

/**
 * 스코프 필터. 뒤쪽 스코프 부분은 미리 검증된 문자열 그대로고, **앞의 형식 변환은 실측으로 붙였다**
 * (2026-09-02). 안 붙이면 세 개 다 틀린 그림이 나온다:
 *
 * | 종류 | 앞에 붙인 것 | 왜 |
 * |---|---|---|
 * | 웨이브폼·히스토그램 | `format=gbrp` | RGB 로 두면 **0~255 풀레인지**라 순수 흰색이 255, 검정이 0 에 선다. YUV(리미티드)로 바꾸면 235/16 에 서서 「양 끝 스파이크」가 아니게 되고, 브라우저 실시간 스코프(RGB)와도 눈금이 어긋난다. 성분 3개도 R·G·B 가 된다. |
 * | 벡터스코프 | `scale=out_color_matrix=bt709:out_range=tv,format=yuv444p` | 색차가 필요해서 YUV 로 가야 하는데, **ffmpeg 의 초록 격자 타깃은 BT.709 «리미티드» 좌표에 그려진다.** 기본 변환(작은 그림이면 BT.601)을 쓰면 100% 컬러바 점이 타깃에서 8~15px 빗나간다. 4:4:4 로 올리는 것은 jpeg 스틸의 4:2:0 색차가 2×2 로 뭉개지지 않게 하려는 것. |
 *
 * **`out_range=tv` 를 빼면 안 된다:** 우리가 실제로 먹이는 스틸은 `renderCover` 가 만든 **jpeg**
 * 이고 그건 `yuvj444p`(풀레인지)다. 매트릭스만 709 로 바꾸면 범위가 풀레인지로 남아
 * 6개 점이 격자 바깥 테두리로 밀려난다(2026-09-02 실측: R 이 (102,15) 대신 (98,1)).
 * `out_range=tv` 를 넣으면 png·jpeg 어느 쪽이 와도 1px 안으로 타깃에 얹힌다.
 *
 * RGB PNG 를 아무 변환 없이 먹이면 **오류 없이 새까만 그림**이 나온다 — 그래서 앞을 비워 두면 안 된다.
 */
export const SCOPE_FILTERS: Record<ScopeKind, string> = {
  waveform: 'format=gbrp,waveform=intensity=0.2:mirror=1:components=7:display=overlay',
  vectorscope:
    'scale=out_color_matrix=bt709:out_range=tv,format=yuv444p,' +
    'vectorscope=mode=color3:graticule=green:flags=name',
  histogram: 'format=gbrp,histogram=display_mode=stack:levels_mode=logarithmic',
};

export function isScopeKind(v: unknown): v is ScopeKind {
  return typeof v === 'string' && (SCOPE_KINDS as readonly string[]).includes(v);
}

/**
 * 캐시 파일 이름 — (프로젝트, 리비전, 시각, 종류) 가 같으면 같은 그림이다.
 * 리비전이 오르면 이름이 달라져 **자동으로 무효화**된다.
 */
export function scopeFileName(
  projectId: string,
  revision: number,
  timeMs: number,
  kind: ScopeKind,
  proxy = false,
): string {
  // 점은 통째로 뺀다 — 경로 구분자를 지워도 `..` 이 남으면 파일 이름이 지저분해진다
  const safe = projectId.replace(/[^\w가-힣-]+/g, '_');
  return `${safe}-r${revision}-t${Math.round(timeMs)}${proxy ? '-p' : ''}-${kind}.png`;
}

/** 스틸 한 장 → 스코프 PNG 한 장. */
export async function renderScopeImage(
  srcAbs: string,
  outAbs: string,
  kind: ScopeKind,
): Promise<{ outPath: string }> {
  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  await runFfmpeg(['-y', '-i', srcAbs, '-vf', SCOPE_FILTERS[kind], '-frames:v', '1', outAbs]);
  return { outPath: outAbs };
}

/**
 * 여러 종류를 한 번에. 이미 있는 파일은 다시 굽지 않는다(캐시).
 * 종류마다 ffmpeg 를 따로 부른다 — 한 그래프에 묶으면 하나가 실패할 때 전부 잃는다.
 */
export async function renderScopeImages(
  srcAbs: string,
  outDir: string,
  fileFor: (kind: ScopeKind) => string,
  kinds: readonly ScopeKind[] = SCOPE_KINDS,
): Promise<Record<string, string>> {
  await fs.mkdir(outDir, { recursive: true });
  const made: Record<string, string> = {};
  for (const kind of kinds) {
    const abs = path.join(outDir, fileFor(kind));
    if (!(await exists(abs))) await renderScopeImage(srcAbs, abs, kind);
    made[kind] = abs;
  }
  return made;
}

async function exists(abs: string): Promise<boolean> {
  try {
    const st = await fs.stat(abs);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

// ── 실시간 ↔ 정밀 대조용 통계 ─────────────────────────────────────────────

export type StillStats = {
  width: number;
  height: number;
  pixels: number;
  /** 0..255 */
  mean: [number, number, number];
  meanY: number;
  meanCb: number;
  meanCr: number;
};

/** 기본 표본 크기 — 브라우저 실시간 스코프의 예산(256×455 ≈ 11.6만)과 같게 잡는다. */
export const STATS_PIXEL_BUDGET = 256 * 455;

/**
 * 통계용 표본 크기. UI `scope-source.ts` 의 `scopeSampleSize` 와 **같은 식**이어야
 * 두 경로의 숫자를 그대로 뺄 수 있다.
 */
export function statsSampleSize(
  width: number,
  height: number,
  budget = STATS_PIXEL_BUDGET,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 };
  const area = width * height;
  const scale = area > budget ? Math.sqrt(budget / area) : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * 스틸을 작게 **점 샘플링**해서 평균 색을 잰다.
 *
 * `flags=neighbor` 인 이유: 브라우저 쪽도 blitFramebuffer NEAREST 로 솎아내므로
 * 같은 방식이어야 두 숫자를 비교할 수 있다. 평균 축소를 쓰면 그 차이만큼 딴 값이 나온다.
 */
export async function measureStillStats(
  srcAbs: string,
  width: number,
  height: number,
): Promise<StillStats> {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const buf = await runFfmpegBuffer(
    [
      '-i', srcAbs,
      '-vf', `scale=${w}:${h}:flags=neighbor`,
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
    ],
    w * h * 4 + 1024,
  );
  return statsFromRgba(buf, w, h);
}

/** 원시 RGBA → 평균. UI 의 `scopeStats` 와 **같은 수식**이라 숫자를 바로 뺄 수 있다. */
export function statsFromRgba(px: Uint8Array, width: number, height: number): StillStats {
  const n = Math.min(width * height, Math.floor(px.length / 4));
  if (n <= 0) {
    return { width, height, pixels: 0, mean: [0, 0, 0], meanY: 0, meanCb: 0, meanCr: 0 };
  }
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < n * 4; i += 4) {
    sr += px[i] as number;
    sg += px[i + 1] as number;
    sb += px[i + 2] as number;
  }
  const r = sr / n;
  const g = sg / n;
  const b = sb / n;
  return {
    width,
    height,
    pixels: n,
    mean: [r, g, b],
    meanY: 0.299 * r + 0.587 * g + 0.114 * b,
    meanCb: -0.169 * r - 0.331 * g + 0.5 * b,
    meanCr: 0.5 * r - 0.419 * g - 0.081 * b,
  };
}

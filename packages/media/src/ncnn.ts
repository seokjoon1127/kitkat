import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { effectiveSignal } from './job-signal.js';

/**
 * ncnn-vulkan 독립 실행 파일 백엔드 — Real-ESRGAN(업스케일)·RIFE(프레임 보간) 공용.
 * 둘 다 같은 저자·같은 ncnn 백엔드라 CLI 형태가 거의 같다(폴더 → 폴더, `-g` 로 GPU 지정).
 *
 * ⚠️ 이 컴퓨터에서 2026-09-01 에 Real-ESRGAN 을 돌리다 Windows 가 5번 다운됐다
 *    (BugCheck 0x116 VIDEO_TDR_ERROR — NVIDIA MX450 의 2020년판 드라이버가 응답 정지).
 *    그래서 GPU 를 «자동(=가장 빠른 것)» 으로 두지 않고, 드라이버 날짜를 보고 고른다.
 */

export type NcnnTool = 'realesrgan' | 'rife';
export type NcnnGpu = { id: number; name: string; driverDate?: Date; recommended: boolean };
export type NcnnInfo = { ok: boolean; exe?: string; models?: string[]; gpus?: NcnnGpu[]; hint?: string };

type ToolDef = {
  dir: string;
  bin: string;
  /** `-h` 출력에 이게 있으면 «응답한다» 로 본다. */
  helpMark: RegExp;
  /** `-t tile-size` 를 받는가. rife 는 안 받는다(넘기면 usage 를 뱉고 죽는다). */
  supportsTile: boolean;
};

const TOOLS: Record<NcnnTool, ToolDef> = {
  realesrgan: {
    dir: 'realesrgan',
    bin: 'realesrgan-ncnn-vulkan',
    helpMark: /-n model-name/,
    supportsTile: true,
  },
  rife: {
    dir: 'rife',
    bin: 'rife-ncnn-vulkan',
    helpMark: /-m model-path/,
    supportsTile: false,
  },
};

/** 타일 자동 하강 순서 — VRAM 부족으로 실패하면 다음 값으로 재시도한다. */
const TILE_LADDER = [512, 256, 128, 64] as const;

/** 드라이버가 이 기간 안쪽이면 «최근» 으로 본다(3년). */
const DRIVER_MAX_AGE_MS = 3 * 365.25 * 24 * 60 * 60 * 1000;

const IMAGE_RE = /\.(png|jpg|jpeg|webp)$/i;

/** 이 파일 기준 저장소 루트 (src/ 든 dist/ 든 3단계 위). */
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function toolPaths(tool: NcnnTool, vendorDir?: string): { dir: string; exe: string } {
  const t = TOOLS[tool];
  const dir = path.join(vendorDir ?? path.join(repoRoot(), 'vendor'), t.dir);
  return { dir, exe: path.join(dir, process.platform === 'win32' ? `${t.bin}.exe` : t.bin) };
}

/**
 * 쓸 수 있는 모델 이름.
 * realesrgan 은 `models/<이름>.param` (배율 접미사 `-x2/-x3/-x4` 는 `-s` 로 정해지므로 떼어낸다),
 * rife 는 최상위 폴더 하나가 모델 하나(`-m rife-v4.6`).
 */
async function listModels(exeDir: string): Promise<string[]> {
  const found = new Set<string>();
  const inModels = await readdir(path.join(exeDir, 'models'), { withFileTypes: true }).catch(() => []);
  for (const e of inModels) {
    if (e.isFile() && e.name.endsWith('.param')) {
      found.add(e.name.replace(/\.param$/, '').replace(/-x[234]$/, ''));
    }
  }
  const top = await readdir(exeDir, { withFileTypes: true }).catch(() => []);
  for (const e of top) {
    if (!e.isDirectory() || e.name === 'models') continue;
    const inner = await readdir(path.join(exeDir, e.name)).catch(() => []);
    if (inner.some((f) => f.endsWith('.param'))) found.add(e.name);
  }
  return [...found].sort();
}

/**
 * Vulkan 물리 장치 목록 — **ncnn 이 `-g` 에 쓰는 것과 같은 순서**.
 *
 * ncnn 도구들은 `-h` 로는 GPU 목록을 찍지 않는다(둘 다 직접 확인했다 — 인자 파싱 뒤
 * `create_gpu_instance()` 전에 반환한다). 그래서 같은 `vkEnumeratePhysicalDevices` 순서를
 * 쓰는 ffmpeg 의 Vulkan 열거를 빌린다. 없는 인덱스(9999)를 달라고 해서 «목록만» 찍고 죽게 한다 —
 * 논리 장치 생성도, 연산 제출도 없다.
 *
 * ⚠️ 이 순서는 WMI(`Win32_VideoController`) 순서와 다르다. 이 컴퓨터에서 실측:
 *    Vulkan 0=GeForce MX450(2020년 드라이버) / 1=Intel Iris Xe(2025년 드라이버),
 *    WMI    0=Intel Iris Xe            / 1=NVIDIA GeForce MX450.
 *    **WMI 순번을 그대로 `-g` 에 넘기면 시스템을 5번 죽인 바로 그 GPU 를 고르게 된다.**
 *    그래서 아래 `mergeGpus` 가 «이름» 으로 짝을 맞춘다.
 */
async function listVulkanGpus(): Promise<{ id: number; name: string }[] | null> {
  const res = await execa(
    'ffmpeg',
    ['-hide_banner', '-v', 'verbose', '-init_hw_device', 'vulkan=vk:9999'],
    { reject: false, timeout: 30_000 },
  ).catch(() => null);
  if (!res) return null;
  const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const at = text.indexOf('GPU listing:');
  if (at < 0) return null;
  const gpus: { id: number; name: string }[] = [];
  for (const line of text.slice(at).split('\n')) {
    const m = /^\s*(?:\[[^\]]*\]\s*)?(\d+):\s*(.+?)\s*\((?:discrete|integrated|virtual|software|other|unknown)\)/.exec(
      line,
    );
    if (m) gpus.push({ id: Number(m[1]), name: m[2]! });
  }
  return gpus;
}

/** Windows 디스플레이 어댑터의 이름·드라이버 날짜 (PCI 장치만). Windows 아니면 빈 배열. */
async function listWmiAdapters(): Promise<{ name: string; driverDate?: Date }[]> {
  if (process.platform !== 'win32') return [];
  const script =
    'Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -like "PCI\\*" } | ' +
    'Select-Object Name, @{n="DriverDate";e={ if ($_.DriverDate) { $_.DriverDate.ToString("yyyy-MM-dd") } }} | ' +
    'ConvertTo-Json -Compress';
  const res = await execa('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    reject: false,
    timeout: 30_000,
  }).catch(() => null);
  if (!res || res.exitCode !== 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(res.stdout).trim() || 'null');
  } catch {
    return [];
  }
  if (parsed == null) return [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: { name: string; driverDate?: Date }[] = [];
  for (const r of rows as { Name?: unknown; DriverDate?: unknown }[]) {
    if (typeof r?.Name !== 'string') continue;
    const d = typeof r.DriverDate === 'string' ? new Date(`${r.DriverDate}T00:00:00Z`) : undefined;
    out.push({ name: r.Name, driverDate: d && Number.isFinite(d.getTime()) ? d : undefined });
  }
  return out;
}

/** 이름 비교용 정규화 — 대소문자·괄호표기·공백·기호를 지운다. */
function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\((r|tm|c)\)/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Vulkan 목록(=ncnn 인덱스)에 WMI 의 드라이버 날짜를 **이름 부분 일치**로 붙인다.
 * ncnn 이 보고하는 이름과 WMI 이름은 다르다 (예: "GeForce MX450" vs "NVIDIA GeForce MX450").
 *
 * 짝이 없거나 둘 이상이면 날짜를 비운다 → `recommended:false` → CPU 로 물러난다(안전한 쪽).
 * 순수 함수 — 조회 결과를 주입해 단위테스트한다.
 */
export function mergeGpus(
  vulkan: readonly { id: number; name: string }[],
  adapters: readonly { name: string; driverDate?: Date }[],
  now: Date = new Date(),
): NcnnGpu[] {
  return vulkan.map((g) => {
    const key = normName(g.name);
    const hits = adapters.filter((a) => {
      const k = normName(a.name);
      return k.length > 0 && key.length > 0 && (k.includes(key) || key.includes(k));
    });
    const driverDate = hits.length === 1 ? hits[0]!.driverDate : undefined;
    const recommended = driverDate != null && now.getTime() - driverDate.getTime() <= DRIVER_MAX_AGE_MS;
    return { id: g.id, name: g.name, driverDate, recommended };
  });
}

/**
 * 쓸 GPU 를 고른다. `-1` 은 CPU.
 * 1) `KITKAT_NCNN_GPU` 가 있으면 그 값 (사용자 명시가 최우선)
 * 2) 없으면 드라이버가 3년 이내인 것 중 첫 번째
 * 3) 없으면 -1 (CPU)
 */
export function pickSafeGpu(gpus: readonly NcnnGpu[], env: NodeJS.ProcessEnv = process.env): number {
  const forced = env.KITKAT_NCNN_GPU?.trim();
  if (forced) {
    const n = Number(forced);
    if (Number.isInteger(n)) return n;
  }
  return gpus.find((g) => g.recommended)?.id ?? -1;
}

function gpuHint(gpus: NcnnGpu[], vulkanOk: boolean): string | undefined {
  if (!vulkanOk) {
    return 'Vulkan 장치 목록을 읽지 못했습니다(ffmpeg 에 vulkan 이 없거나 드라이버가 없습니다). CPU(-g -1)로 돌립니다 — 느립니다.';
  }
  if (gpus.length === 0) return 'Vulkan GPU 가 없습니다. CPU(-g -1)로 돌립니다 — 느립니다.';
  const safe = gpus.filter((g) => g.recommended);
  if (safe.length === 0) {
    const listed = gpus
      .map((g) => `${g.id}:${g.name}(${g.driverDate ? g.driverDate.toISOString().slice(0, 10) : '드라이버 날짜 확인 불가'})`)
      .join(', ');
    return `드라이버가 3년 이내인 GPU 가 없습니다 [${listed}]. CPU(-g -1)로 돌립니다 — 느립니다. 특정 GPU 를 쓰려면 KITKAT_NCNN_GPU 로 지정하세요.`;
  }
  const g = safe[0]!;
  return `GPU ${g.id} «${g.name}» (드라이버 ${g.driverDate!.toISOString().slice(0, 10)}) 을 씁니다.`;
}

/**
 * 실행 파일이 준비됐는지 · 어떤 모델이 있는지 · 어떤 GPU 를 쓸 수 있는지.
 * **throw 하지 않는다** — 없으면 `{ok:false, hint}` 를 돌려준다.
 */
export async function ncnnInfo(tool: NcnnTool, opts?: { vendorDir?: string }): Promise<NcnnInfo> {
  const t = TOOLS[tool];
  const { dir, exe } = toolPaths(tool, opts?.vendorDir);

  const isFile = await stat(exe).then((s) => s.isFile(), () => false);
  if (!isFile) {
    return {
      ok: false,
      hint: `${tool} 실행 파일이 없습니다. \`node scripts/prewarm.mjs ${tool}\` 로 받으세요. (찾은 위치: ${exe})`,
    };
  }

  const probe = await execa(exe, ['-h'], { reject: false, timeout: 20_000, cwd: dir }).catch(() => null);
  const help = probe ? `${probe.stdout ?? ''}${probe.stderr ?? ''}` : '';
  if (!t.helpMark.test(help)) {
    return {
      ok: false,
      exe,
      hint: `${tool} 실행 파일이 -h 에 응답하지 않습니다: ${help.slice(0, 200) || '(출력 없음)'}`,
    };
  }

  const models = await listModels(dir);
  const vulkan = await listVulkanGpus();
  const gpus = vulkan == null ? [] : mergeGpus(vulkan, await listWmiAdapters());
  return { ok: true, exe, models, gpus, hint: gpuHint(gpus, vulkan != null) };
}

/** VRAM 부족으로 죽었나 — 타일을 줄여 재시도할 값어치가 있는 실패인지 가린다. */
function isOutOfMemory(text: string): boolean {
  return /out of (device |host )?memory|vkAllocateMemory|VK_ERROR_OUT_OF|failed to allocate|-1000069000|\berror -2\b/i.test(
    text,
  );
}

async function countImages(dir: string): Promise<number> {
  const files = await readdir(dir).catch(() => []);
  return files.filter((f) => IMAGE_RE.test(f)).length;
}

async function emptyDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

/**
 * 프레임 폴더 → 프레임 폴더.
 * 도구는 진행률을 찍지 않으므로 출력 폴더의 파일 수를 세어 알린다.
 * realesrgan 은 VRAM 부족 시 타일을 512→256→128→64 로 낮춰 재시도한다(rife 는 `-t` 가 없다).
 */
export async function ncnnRun(
  tool: NcnnTool,
  opts: {
    inDir: string;
    outDir: string;
    args: string[];
    gpuId?: number;
    tile?: number;
    onProgress?: (done: number, total: number) => void;
    /** 잡 큐 시간 초과 → 실행 파일도 같이 죽인다 (리뷰 #12) */
    signal?: AbortSignal;
  },
): Promise<void> {
  const info = await ncnnInfo(tool);
  if (!info.ok || info.exe == null) throw new Error(info.hint ?? `${tool} 을(를) 쓸 수 없습니다`);

  const gpuId = opts.gpuId ?? pickSafeGpu(info.gpus ?? []);
  const t = TOOLS[tool];
  const tiles: readonly number[] = t.supportsTile
    ? opts.tile != null
      ? [opts.tile]
      : TILE_LADDER
    : [];

  const total = await countImages(opts.inDir);
  await mkdir(opts.outDir, { recursive: true });

  const onProgress = opts.onProgress;
  const timer =
    onProgress && total > 0
      ? setInterval(() => {
          void countImages(opts.outDir).then((done) => onProgress(Math.min(done, total), total));
        }, 500)
      : null;

  try {
    let lastErr = '';
    for (let i = 0; i < Math.max(1, tiles.length); i++) {
      // 이전 시도의 부분 결과가 남으면 다음 시도 결과와 섞인다
      if (i > 0) await emptyDir(opts.outDir);
      const args = ['-i', opts.inDir, '-o', opts.outDir, '-g', String(gpuId)];
      if (tiles.length > 0) args.push('-t', String(tiles[i]));
      args.push(...opts.args);

      const res = await execa(info.exe, args, { reject: false, cwd: path.dirname(info.exe), cancelSignal: effectiveSignal(opts.signal) });
      if (res.exitCode === 0) {
        onProgress?.(total, total);
        return;
      }
      lastErr = `${res.stderr ?? ''}${res.stdout ?? ''}`.trim();
      // 메모리 문제가 아니면 타일을 줄여도 같은 이유로 또 죽는다
      if (!isOutOfMemory(lastErr)) break;
    }
    throw new Error(`${tool} 실행 실패 (gpu=${gpuId}): ${lastErr.slice(0, 400) || '(출력 없음)'}`);
  } finally {
    if (timer) clearInterval(timer);
  }
}

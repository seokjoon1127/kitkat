import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergeGpus, ncnnInfo, pickSafeGpu, type NcnnGpu } from '../src/ncnn.js';

const NOW = new Date('2026-09-02T00:00:00Z');
const NEW_DRIVER = new Date('2025-05-25T00:00:00Z'); // Intel Iris Xe (이 컴퓨터)
const OLD_DRIVER = new Date('2020-10-19T00:00:00Z'); // NVIDIA MX450 (시스템을 5번 죽인 것)

const gpu = (id: number, name: string, driverDate?: Date): NcnnGpu => ({
  id,
  name,
  driverDate,
  recommended: driverDate != null && NOW.getTime() - driverDate.getTime() <= 3 * 365.25 * 864e5,
});

describe('pickSafeGpu', () => {
  it('드라이버가 새 GPU 만 있으면 첫 번째를 고른다', () => {
    const gpus = [gpu(0, 'Intel(R) Iris(R) Xe Graphics', NEW_DRIVER), gpu(1, 'Some New GPU', NEW_DRIVER)];
    expect(pickSafeGpu(gpus, {})).toBe(0);
  });

  it('드라이버가 전부 오래됐으면 CPU(-1)로 물러난다', () => {
    const gpus = [gpu(0, 'GeForce MX450', OLD_DRIVER), gpu(1, 'GeForce GT 710', OLD_DRIVER)];
    expect(pickSafeGpu(gpus, {})).toBe(-1);
  });

  it('섞여 있으면 드라이버가 최근인 쪽을 고른다 (이 컴퓨터의 실제 배치)', () => {
    // Vulkan 열거 순서: 0=MX450(2020), 1=Iris Xe(2025)
    const gpus = [gpu(0, 'GeForce MX450', OLD_DRIVER), gpu(1, 'Intel(R) Iris(R) Xe Graphics', NEW_DRIVER)];
    expect(pickSafeGpu(gpus, {})).toBe(1);
  });

  it('KITKAT_NCNN_GPU 가 최우선 — 오래된 GPU 라도 사용자 지정을 따른다', () => {
    const gpus = [gpu(0, 'GeForce MX450', OLD_DRIVER), gpu(1, 'Intel(R) Iris(R) Xe Graphics', NEW_DRIVER)];
    expect(pickSafeGpu(gpus, { KITKAT_NCNN_GPU: '0' })).toBe(0);
    expect(pickSafeGpu(gpus, { KITKAT_NCNN_GPU: '-1' })).toBe(-1);
    expect(pickSafeGpu(gpus, { KITKAT_NCNN_GPU: ' 1 ' })).toBe(1);
  });

  it('KITKAT_NCNN_GPU 가 숫자가 아니면 무시하고 자동 선택으로 돌아간다', () => {
    const gpus = [gpu(0, 'GeForce MX450', OLD_DRIVER), gpu(1, 'Intel(R) Iris(R) Xe Graphics', NEW_DRIVER)];
    expect(pickSafeGpu(gpus, { KITKAT_NCNN_GPU: 'intel' })).toBe(1);
    expect(pickSafeGpu(gpus, { KITKAT_NCNN_GPU: '' })).toBe(1);
  });

  it('GPU 가 하나도 없으면 CPU(-1)', () => {
    expect(pickSafeGpu([], {})).toBe(-1);
  });

  it('드라이버 날짜를 못 읽은 GPU 는 안전한 쪽(CPU)으로 둔다', () => {
    expect(pickSafeGpu([gpu(0, 'Unknown Device', undefined)], {})).toBe(-1);
  });
});

describe('mergeGpus', () => {
  it('ncnn 이름과 WMI 이름이 달라도 부분 일치로 드라이버 날짜를 붙인다', () => {
    // Vulkan 은 "GeForce MX450", WMI 는 "NVIDIA GeForce MX450" 로 보고한다
    const merged = mergeGpus(
      [
        { id: 0, name: 'GeForce MX450' },
        { id: 1, name: 'Intel(R) Iris(R) Xe Graphics' },
      ],
      [
        { name: 'Intel(R) Iris(R) Xe Graphics', driverDate: NEW_DRIVER },
        { name: 'NVIDIA GeForce MX450', driverDate: OLD_DRIVER },
      ],
      NOW,
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ id: 0, driverDate: OLD_DRIVER, recommended: false });
    expect(merged[1]).toMatchObject({ id: 1, driverDate: NEW_DRIVER, recommended: true });
    // WMI 순서(Intel 이 0번)를 그대로 쓰면 MX450 을 고르게 된다 — 이름 매칭이 그걸 막는다
    expect(pickSafeGpu(merged, {})).toBe(1);
  });

  it('짝을 못 찾으면 날짜 없이 recommended:false (안전한 쪽)', () => {
    const merged = mergeGpus([{ id: 0, name: 'Llvmpipe' }], [{ name: 'NVIDIA GeForce MX450', driverDate: NEW_DRIVER }], NOW);
    expect(merged[0]).toMatchObject({ driverDate: undefined, recommended: false });
  });

  it('같은 이름이 둘이면 애매하므로 날짜를 붙이지 않는다', () => {
    const merged = mergeGpus(
      [{ id: 0, name: 'GeForce MX450' }],
      [
        { name: 'NVIDIA GeForce MX450', driverDate: NEW_DRIVER },
        { name: 'NVIDIA GeForce MX450', driverDate: OLD_DRIVER },
      ],
      NOW,
    );
    expect(merged[0]!.recommended).toBe(false);
  });

  it('드라이버가 정확히 3년 경계면 «최근» 으로 본다', () => {
    const justInside = new Date(NOW.getTime() - 3 * 365.25 * 864e5 + 1000);
    const justOutside = new Date(NOW.getTime() - 3 * 365.25 * 864e5 - 1000);
    expect(mergeGpus([{ id: 0, name: 'X' }], [{ name: 'X', driverDate: justInside }], NOW)[0]!.recommended).toBe(true);
    expect(mergeGpus([{ id: 0, name: 'X' }], [{ name: 'X', driverDate: justOutside }], NOW)[0]!.recommended).toBe(false);
  });
});

describe('ncnnInfo', () => {
  it('실행 파일이 없으면 throw 하지 않고 {ok:false, hint} 를 돌려준다', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'kitkat-vendor-'));
    try {
      for (const tool of ['realesrgan', 'rife'] as const) {
        const info = await ncnnInfo(tool, { vendorDir: empty });
        expect(info.ok).toBe(false);
        expect(info.exe).toBeUndefined();
        expect(info.hint).toContain(`prewarm.mjs ${tool}`);
      }
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('설치돼 있으면 모델 목록을 읽는다 (설치 안 됐으면 건너뜀)', async () => {
    for (const [tool, expected] of [
      ['realesrgan', 'realesrgan-x4plus'],
      ['rife', 'rife-v4.6'],
    ] as const) {
      const info = await ncnnInfo(tool);
      if (!info.ok) continue; // vendor/ 가 없는 환경에서는 검사 대상이 아니다
      expect(info.exe).toContain(tool);
      expect(info.models).toContain(expected);
      // 배율 접미사(-x2/-x3/-x4)는 -s 로 정해지므로 모델 이름에 남지 않는다
      expect(info.models!.every((m) => !/-x[234]$/.test(m))).toBe(true);
      expect(Array.isArray(info.gpus)).toBe(true);
    }
  }, 90_000);
});

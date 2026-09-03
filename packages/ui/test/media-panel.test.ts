// W8 F1·F2 — MediaPanel 의 순수 헬퍼 (드롭다운 기본값 · 프레임 진행률 표시 · 501 안내)
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OP_OPTS,
  engineMissingNotice,
  jobProgressText,
  INTERP_ENGINE_LABELS,
  INTERP_MODEL_LABELS,
  UPSCALE_ENGINE_LABELS,
  UPSCALE_MODEL_LABELS,
} from '../src/components/MediaPanel';

describe('jobProgressText — 「AI 업스케일 중 312/900」', () => {
  it('대기 중인 잡', () => {
    expect(jobProgressText({ status: 'queued', progress: 0 })).toBe('대기 중…');
  });

  it('서버가 프레임 수를 보내면 퍼센트 앞에 붙인다 (몇 시간짜리 잡의 남은 시간 가늠용)', () => {
    expect(jobProgressText({ status: 'running', progress: 0.3467, detail: '312/900 프레임' })).toBe(
      '312/900 프레임 (35%)',
    );
  });

  it('detail 이 없으면 퍼센트만 (기존 잡들은 그대로다)', () => {
    expect(jobProgressText({ status: 'running', progress: 0.5 })).toBe('50%');
  });

  it('대기 중이면 detail 이 있어도 「대기 중…」이다 (아직 한 장도 안 했다)', () => {
    expect(jobProgressText({ status: 'queued', progress: 0, detail: '0/900 프레임' })).toBe('대기 중…');
  });
});

describe('engineMissingNotice — 501 안내', () => {
  it('보컬 분리는 Demucs 설치 안내', () => {
    expect(engineMissingNotice('separate')).toContain('Demucs');
  });

  it('서버가 준 문구(prewarm 명령 포함)를 그대로 보여준다', () => {
    const msg = 'AI 업스케일 엔진(Real-ESRGAN)이 없습니다. `node scripts/prewarm.mjs realesrgan`';
    expect(engineMissingNotice('업스케일', msg)).toBe(msg);
  });

  it('서버 문구가 비었으면 최소한의 안내는 낸다', () => {
    expect(engineMissingNotice('업스케일', '')).toBe('업스케일 엔진이 없습니다.');
  });
});

describe('드롭다운 기본값·선택지', () => {
  it('기본은 2배 · 엔진 자동 · 실사 모델 · 60fps · rife-v4.6', () => {
    expect(DEFAULT_OP_OPTS).toEqual({
      scale: 2,
      upEngine: 'auto',
      upModel: 'realesrgan-x4plus',
      fps: 60,
      ipEngine: 'auto',
      ipModel: 'rife-v4.6',
    });
  });

  it('엔진 선택지는 auto·ai·폴백 셋뿐이다', () => {
    expect(UPSCALE_ENGINE_LABELS.map(([v]) => v)).toEqual(['auto', 'ai', 'lanczos']);
    expect(INTERP_ENGINE_LABELS.map(([v]) => v)).toEqual(['auto', 'ai', 'minterpolate']);
  });

  it('기본 모델이 목록에 실제로 있다 (드롭다운이 빈 값으로 시작하지 않는다)', () => {
    expect(UPSCALE_MODEL_LABELS.map(([v]) => v)).toContain(DEFAULT_OP_OPTS.upModel);
    expect(INTERP_MODEL_LABELS.map(([v]) => v)).toContain(DEFAULT_OP_OPTS.ipModel);
  });

  it('모델 라벨은 전부 사람이 읽는 이름이 붙어 있다', () => {
    for (const [, label] of [...UPSCALE_MODEL_LABELS, ...INTERP_MODEL_LABELS]) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

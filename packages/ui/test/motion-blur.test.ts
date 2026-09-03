// W8 F3-A — 인스펙터가 «묻기 전에» 계산하는 예상 시간.
// 서버가 잡을 등록한 뒤에 알려주면 늦다(그 순간 이미 굽기 시작한다) → UI 가 직접 센다.
import { describe, expect, it } from 'vitest';
import { MOTION_BLUR_SEC_PER_SEC as MEDIA_SEC_PER_SEC } from '@kitkat/media';
import {
  DEFAULT_SOURCE_MOTION_BLUR,
  DEFAULT_TRANSFORM_BLUR,
  estimateSourceMotionBlurSec,
  formatEstimate,
  motionBlurConfirmMessage,
  motionBlurFrames,
  MOTION_BLUR_SEC_PER_SEC,
} from '../src/components/sections/inspector-utils';

const FULL_HD_VERTICAL = { durationMs: 1000, width: 1080, height: 1920 };

describe('실측 계수가 굽는 쪽과 어긋나지 않는다', () => {
  it('@kitkat/media 의 계수와 같은 값이다 (한쪽만 고치면 예상 시간이 거짓말이 된다)', () => {
    expect(MOTION_BLUR_SEC_PER_SEC.precise).toBe(MEDIA_SEC_PER_SEC.precise);
    expect(MOTION_BLUR_SEC_PER_SEC.fast).toBe(MEDIA_SEC_PER_SEC.fast);
  });
});

describe('기본값', () => {
  it('소스 모션 블러의 기본 품질은 **precise** — 느리다고 몰래 fast 로 바꾸지 않는다', () => {
    expect(DEFAULT_SOURCE_MOTION_BLUR).toEqual({ shutterAngle: 180, quality: 'precise' });
  });

  it('트랜스폼 블러 기본은 180° · 12장', () => {
    expect(DEFAULT_TRANSFORM_BLUR).toEqual({ shutterAngle: 180, samples: 12 });
  });
});

describe('섞을 프레임 수', () => {
  it('precise 180° 는 8장의 절반 = 4장', () => {
    expect(motionBlurFrames({ shutterAngle: 180, quality: 'precise' })).toBe(4);
  });

  it('fast 180° 는 3장', () => {
    expect(motionBlurFrames({ shutterAngle: 180, quality: 'fast' })).toBe(3);
  });

  it('각도 0 근처는 2장 미만 = 항등 (굽지 않는다)', () => {
    expect(motionBlurFrames({ shutterAngle: 0, quality: 'precise' })).toBe(0);
    expect(estimateSourceMotionBlurSec({ shutterAngle: 0, quality: 'precise' }, FULL_HD_VERTICAL)).toBe(0);
  });
});

describe('예상 시간', () => {
  it('1080×1920 1초 = precise 77초 · fast 1초 (계획 03 실측)', () => {
    expect(estimateSourceMotionBlurSec({ shutterAngle: 180, quality: 'precise' }, FULL_HD_VERTICAL)).toBe(77);
    expect(estimateSourceMotionBlurSec({ shutterAngle: 180, quality: 'fast' }, FULL_HD_VERTICAL)).toBe(1);
  });

  it('30초 광고는 precise 로 2310초 = 「약 39분」 — 이 숫자를 보여주고 묻는다', () => {
    const sec = estimateSourceMotionBlurSec(
      { shutterAngle: 180, quality: 'precise' },
      { durationMs: 30_000, width: 1080, height: 1920 },
    );
    expect(sec).toBe(2310);
    expect(formatEstimate(sec)).toBe('약 39분');
  });

  it('해상도에 비례한다 (540×960 은 픽셀이 1/4 → 시간도 1/4)', () => {
    expect(
      estimateSourceMotionBlurSec({ shutterAngle: 180, quality: 'precise' },
        { durationMs: 1000, width: 540, height: 960 }),
    ).toBe(19);
  });

  it('길이에 비례한다', () => {
    const a = estimateSourceMotionBlurSec({ shutterAngle: 180, quality: 'precise' },
      { ...FULL_HD_VERTICAL, durationMs: 4000 });
    expect(a).toBe(77 * 4);
  });
});

describe('사람 말로 바꾸기', () => {
  it('1분 미만은 초, 1시간 미만은 분, 그 위는 시간+분', () => {
    expect(formatEstimate(1)).toBe('약 1초');
    expect(formatEstimate(45)).toBe('약 45초');
    expect(formatEstimate(2310)).toBe('약 39분');
    expect(formatEstimate(3600)).toBe('약 1시간');
    expect(formatEstimate(4320)).toBe('약 1시간 12분');
  });

  it('0 이하는 빈 문자열 (「약 0초 걸립니다」를 안 띄운다)', () => {
    expect(formatEstimate(0)).toBe('');
    expect(formatEstimate(-5)).toBe('');
    expect(formatEstimate(Number.NaN)).toBe('');
  });

  it('물어보는 문장에 시간이 들어간다 — 「계속할까요?」만 띄우지 않는다', () => {
    const msg = motionBlurConfirmMessage(2310);
    expect(msg).toContain('약 39분');
    expect(msg).toContain('계속할까요?');
  });
});

// W8 F10 — 추적 결과 판정·파싱. opencv 없이 도는 순수 부분만 본다.
import { describe, expect, it } from 'vitest';
import {
  classifyTrack,
  makeStderrSink,
  mergeTrackedFrames,
  parseTrackJson,
  trackGaps,
  DEFAULT_SCORE_THRESHOLD,
  VITTRACK_MODEL_SHA256,
  VITTRACK_MODEL_URL,
  type TrackFrame,
} from '../src/track.js';

const FRAME_W = 1280;
const FRAME_H = 720;

/** score 배열 → 프레임 목록. 상자는 기본 100×100 (온전함). */
function frames(scores: number[], box?: (i: number) => Partial<TrackFrame>): TrackFrame[] {
  return scores.map((s, i) => ({
    frame: i,
    ms: i * 33,
    x: 100,
    y: 100,
    w: 100,
    h: 100,
    score: s,
    ...(box ? box(i) : {}),
  }));
}

const classify = (f: TrackFrame[], scoreThreshold?: number) =>
  classifyTrack(f, {
    anchor: { w: 100, h: 100 },
    frameW: FRAME_W,
    frameH: FRAME_H,
    ...(scoreThreshold !== undefined ? { scoreThreshold } : {}),
  });

describe('classifyTrack — 점수', () => {
  it('기본 임계는 0.45 다 (합성 5종 745프레임 실측으로 정한 값)', () => {
    expect(DEFAULT_SCORE_THRESHOLD).toBe(0.45);
  });

  it('기준(첫) 프레임은 언제나 성공이다 — 사용자가 찍어 준 상자다', () => {
    expect(classify(frames([0.0, 0.9, 0.9]))[0]!.ok).toBe(true);
  });

  it('임계 위는 성공, 아래는 실패', () => {
    const out = classify(frames([1, 0.9, 0.9, 0.1, 0.9, 0.9]), 0.45);
    expect(out.map((f) => f.ok)).toEqual([true, true, true, true, true, true]); // 1프레임 실패는 이어붙임
    const out2 = classify(frames([1, 0.1, 0.1, 0.1, 0.9]), 0.45);
    expect(out2[1]!.ok).toBe(false);
  });

  it('임계를 인자로 낮출 수 있다 (빠른 움직임용)', () => {
    const f = frames([1, 0.3, 0.3, 0.3, 0.9]);
    expect(classify(f, 0.45).filter((x) => x.ok).length).toBe(1);
    expect(classify(f, 0.2).every((x) => x.ok)).toBe(true);
  });
});

describe('classifyTrack — 상자 온전성 (점수만으로는 못 잡는 실패)', () => {
  it('점수가 높아도 상자가 화면을 통째로 덮으면 실패다', () => {
    // 실측: 대상을 놓친 뒤 ViT 는 1280×720 영상에서 1397×812 상자를 잡고 점수 0.78 을 돌려준다.
    const f = frames([1, 0.9, 0.78, 0.78, 0.78, 0.78], (i) =>
      i >= 2 ? { x: -48, y: -55, w: 1397, h: 812 } : {},
    );
    const out = classify(f);
    expect(out.slice(2).every((x) => x.ok)).toBe(false);
    expect(out.filter((x) => x.ok).length).toBe(2);
  });

  it('기준 상자 넓이의 16배를 넘으면 실패다', () => {
    const ok = classify(frames([1, 0.9], (i) => (i === 1 ? { w: 390, h: 100 } : {})));
    expect(ok[1]!.ok).toBe(true); // 3.9배 — 정상 (스케일 변화)
    const bad = classify(frames([1, 0.9], (i) => (i === 1 ? { w: 1700, h: 100 } : {})));
    expect(bad[1]!.ok).toBe(false); // 17배
  });

  it('폭·높이가 0 이면 실패다', () => {
    expect(classify(frames([1, 0.99], (i) => (i === 1 ? { w: 0, h: 0 } : {})))[1]!.ok).toBe(false);
  });

  it('상자가 커져도 16배 안이고 화면 80% 이하면 성공이다 (1.0→2.0배 추종)', () => {
    const grow = frames(Array(20).fill(0.8), (i) => ({ w: 100 + i * 5, h: 100 + i * 5 }));
    grow[0]!.score = 1;
    expect(classify(grow).every((x) => x.ok)).toBe(true);
  });
});

describe('classifyTrack — 이어붙임과 sticky', () => {
  it('3프레임 미만의 짧은 실패는 앞뒤를 이어 준다 (깜빡임 방지)', () => {
    const out = classify(frames([1, 0.9, 0.1, 0.1, 0.9, 0.9]), 0.45);
    expect(out.every((x) => x.ok)).toBe(true);
  });

  it('3프레임 연속 실패면 «그 뒤 전부» 실패다 — ViT 는 스스로 못 돌아온다', () => {
    const out = classify(frames([1, 0.9, 0.9, 0.1, 0.1, 0.1, 0.9, 0.9, 0.9]), 0.45);
    expect(out.map((x) => x.ok)).toEqual([true, true, true, false, false, false, false, false, false]);
  });

  it('끝에 매달린 짧은 실패는 이어붙이지 않는다 (진짜 실패다)', () => {
    const out = classify(frames([1, 0.9, 0.9, 0.1]), 0.45);
    expect(out[3]!.ok).toBe(false);
  });
});

describe('trackGaps', () => {
  it('연속된 실패를 구간으로 묶는다', () => {
    const out = classify(frames([1, 0.9, 0.1, 0.1, 0.1, 0.1]), 0.45);
    const gaps = trackGaps(out);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ startFrame: 2, endFrame: 5, startMs: 66, endMs: 165 });
  });

  it('실패가 없으면 빈 배열', () => {
    expect(trackGaps(classify(frames([1, 0.9, 0.9])))).toEqual([]);
  });
});

// ── 역방향·양방향 ─────────────────────────────────────────────────────────

/** 역방향 패스가 주는 모양 — **추적 순서**(기준 프레임이 먼저, 프레임 번호가 줄어든다). */
function backFrames(anchor: number, scores: number[]): TrackFrame[] {
  return scores.map((s, i) => ({
    frame: anchor - i,
    ms: (anchor - i) * 33,
    x: 100, y: 100, w: 100, h: 100,
    score: i === 0 ? 1 : s,
  }));
}

describe('classifyTrack — 역방향도 «추적 순서» 로 판정한다', () => {
  it('역방향 sticky 는 배열 순서(= 시간 역순)로 걸린다 — 기준에서 멀어질수록 실패다', () => {
    // 기준 20 에서 뒤로. 17·16·15 에서 3연속 실패 → 그보다 «앞쪽»(번호가 작은 쪽)이 전부 실패.
    const out = classify(backFrames(20, [1, 0.9, 0.9, 0.1, 0.1, 0.1, 0.9, 0.9]));
    expect(out.map((f) => f.ok)).toEqual([true, true, true, false, false, false, false, false]);
    // 시간순으로 보면 앞쪽(13..17)이 실패, 뒤쪽(18..20)이 성공이다
    const byFrame = new Map(out.map((f) => [f.frame, f.ok]));
    expect(byFrame.get(20)).toBe(true);
    expect(byFrame.get(18)).toBe(true);
    expect(byFrame.get(17)).toBe(false);
    expect(byFrame.get(13)).toBe(false);
  });

  it('기준 프레임은 역방향에서도 언제나 성공이다', () => {
    expect(classify(backFrames(9, [1, 0.1, 0.1, 0.1]))[0]!.ok).toBe(true);
  });
});

describe('mergeTrackedFrames — 앞·뒤 이어 붙이기', () => {
  const cls = (f: TrackFrame[]) => classify(f);

  it('기준 프레임이 «하나만» 남는다 (앞뒤 패스가 둘 다 내보낸다)', () => {
    const fwd = cls(frames([1, 0.9, 0.9]).map((f) => ({ ...f, frame: f.frame + 10, ms: (f.frame + 10) * 33 })));
    const back = cls(backFrames(10, [1, 0.9, 0.9]));
    const merged = mergeTrackedFrames(fwd, back);
    expect(merged.filter((f) => f.frame === 10)).toHaveLength(1);
    expect(merged.filter((f) => f.frame === 10)[0]!.score).toBe(1);
  });

  it('역순으로 온 역방향 결과를 시간순으로 세운다', () => {
    const merged = mergeTrackedFrames(cls(backFrames(10, [1, 0.9, 0.9, 0.9])));
    expect(merged.map((f) => f.frame)).toEqual([7, 8, 9, 10]);
  });

  it('앞·뒤를 합치면 한 줄로 이어진다 (빠진 프레임도 겹친 프레임도 없다)', () => {
    const fwd = cls(
      Array.from({ length: 5 }, (_, i) => ({ frame: 10 + i, ms: (10 + i) * 33, x: 100, y: 100, w: 100, h: 100, score: i === 0 ? 1 : 0.9 })),
    );
    const back = cls(backFrames(10, [1, 0.9, 0.9, 0.9, 0.9, 0.9]));
    const merged = mergeTrackedFrames(fwd, back);
    expect(merged.map((f) => f.frame)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(new Set(merged.map((f) => f.frame)).size).toBe(merged.length);
  });

  it('겹치면 점수가 높은 쪽이 남는다', () => {
    const a: TrackFrame[] = [{ frame: 3, ms: 99, x: 1, y: 1, w: 100, h: 100, score: 0.5 }];
    const b: TrackFrame[] = [{ frame: 3, ms: 99, x: 9, y: 9, w: 100, h: 100, score: 0.8 }];
    expect(mergeTrackedFrames(classify(a), classify(b))[0]!.x).toBe(9);
  });

  it('한 방향만 줘도 그대로 (정렬만 한다)', () => {
    const one = cls(frames([1, 0.9, 0.9]));
    expect(mergeTrackedFrames(one).map((f) => f.frame)).toEqual([0, 1, 2]);
  });

  it('실패 판정(ok)은 합칠 때 뒤집히지 않는다 — 각 패스에서 정한 그대로다', () => {
    const back = cls(backFrames(20, [1, 0.9, 0.9, 0.1, 0.1, 0.1]));
    const merged = mergeTrackedFrames(back);
    expect(merged.filter((f) => f.ok).map((f) => f.frame)).toEqual([18, 19, 20]);
  });
});

describe('parseTrackJson', () => {
  it('정상 JSON 을 읽는다', () => {
    const r = parseTrackJson(
      JSON.stringify({ fps: 29.97, width: 1080, height: 1920, frames: [{ frame: 0, ms: 0, x: 1, y: 2, w: 3, h: 4, score: 0.9 }] }),
    );
    expect(r.fps).toBeCloseTo(29.97);
    expect(r.width).toBe(1080);
    expect(r.frames).toHaveLength(1);
  });

  it('JSON 이 아니면 한국어로 실패한다', () => {
    expect(() => parseTrackJson('그냥 글자')).toThrow(/JSON/);
  });

  it('frames 가 없거나 fps 가 이상하면 실패한다', () => {
    expect(() => parseTrackJson('{"fps":30}')).toThrow(/frames/);
    expect(() => parseTrackJson('{"fps":0,"frames":[]}')).toThrow(/fps/);
  });
});

describe('makeStderrSink — PROGRESS 한 줄 규약', () => {
  it('PROGRESS 줄만 진행률로 넘기고 나머지는 오류로 모은다', () => {
    const seen: [number, number, number][] = [];
    const sink = makeStderrSink((p, d, t) => seen.push([p, d, t]));
    sink.push('[ WARN:0@0.03] global net_impl_backend.cpp\n');
    sink.push('PROGRESS 0.4200 42 100\n');
    sink.push('Traceback (most recent call last):\n');
    expect(seen).toEqual([[0.42, 42, 100]]);
    expect(sink.text()).toContain('WARN');
    expect(sink.text()).toContain('Traceback');
    expect(sink.text()).not.toContain('PROGRESS');
  });

  it('줄이 청크 경계에서 잘려도 붙여 읽는다', () => {
    const seen: number[] = [];
    const sink = makeStderrSink((p) => seen.push(p));
    sink.push('PROG');
    sink.push('RESS 0.5 5 10\nPROGRESS 1.0 10 10\n');
    expect(seen).toEqual([0.5, 1]);
  });

  it('개수 없는 옛 형식(PROGRESS 0.42)도 읽는다', () => {
    const seen: [number, number, number][] = [];
    makeStderrSink((p, d, t) => seen.push([p, d, t])).push('PROGRESS 0.42\n');
    expect(seen).toEqual([[0.42, 0, 0]]);
  });
});

describe('모델 상수', () => {
  it('opencv_zoo 의 vittrack 모델을 가리키고 체크섬이 박혀 있다', () => {
    expect(VITTRACK_MODEL_URL).toContain('opencv_zoo');
    expect(VITTRACK_MODEL_URL).toContain('object_tracking_vittrack_2023sep.onnx');
    expect(VITTRACK_MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

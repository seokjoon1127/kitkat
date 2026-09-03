// W8 F8·F9 — 인스펙터·펜 툴의 «순수» 로직.
//
// UI 테스트가 확인할 것은 「사용자가 누른 것이 문서에 무엇으로 들어가는가」다 —
// 엔진이 거부하지 않는 값인가까지. 기하 계산 자체는 renderer 의 mask-w8.test.ts 가 본다.
import { describe, expect, it } from 'vitest';
import { createEmptyProject, validateDoc } from '@kitkat/schema';
import type { Mask, ProjectDoc, TextAnim, VideoClip } from '@kitkat/schema';
import { applyCommands } from '@kitkat/engine';
import { parseMaskShape, serializeMaskShape } from '@kitkat/renderer/composition';
import {
  clipMasks,
  defaultMask,
  defaultPathMask,
  MASK_OP_OPTIONS,
  MASK_SHAPE_OPTIONS,
  masksPatch,
  maskShapeLocked,
  TEXT_ANIM_LABELS,
  TEXT_ANIM_UNIT_LABELS,
  textAnimHint,
  textAnimUnitOptions,
  textUnitCount,
} from '../src/components/sections/inspector-utils.js';
import {
  deleteVertex,
  moveHandle,
  moveVertex,
  nudge,
  ShapeHistory,
  toggleSmooth,
} from '../src/components/sections/MaskEditor.js';

// ── 문서에 실제로 들어가는가 ─────────────────────────────────────────────

function docWithClip(): ProjectDoc {
  const doc = createEmptyProject({ name: 'x', width: 1080, height: 1920, fps: 30 });
  doc.assets.a1 = { id: 'a1', kind: 'video', src: 'a.mp4', name: 'a', duration: 5000, width: 1080, height: 1920 };
  doc.tracks[0]!.clips.push({
    id: 'v1', kind: 'video', assetId: 'a1', start: 0, duration: 2000,
    in: 0, out: 2000, speed: 1, volume: 1,
  } as VideoClip);
  return validateDoc(doc);
}

const clipOf = (d: ProjectDoc): VideoClip => d.tracks[0]!.clips[0] as VideoClip;

describe('마스크 목록 ↔ 문서', () => {
  it('한 장이면 `mask` 로, 두 장부터 `masks` 로 저장한다 (기존 문서 모양 유지)', () => {
    expect(masksPatch([])).toEqual({ mask: null, masks: null });
    const one = defaultMask();
    expect(masksPatch([one])).toEqual({ mask: one, masks: null });
    const two = [one, defaultPathMask()];
    expect(masksPatch(two)).toEqual({ mask: null, masks: two });
  });

  it('clipMasks 는 렌더러와 같은 규칙 — masks 가 있으면 mask 는 무시', () => {
    const a = defaultMask();
    const b = defaultPathMask();
    expect(clipMasks({})).toEqual([]);
    expect(clipMasks({ mask: a })).toEqual([a]);
    expect(clipMasks({ mask: a, masks: [b] })).toEqual([b]);
  });

  it('엔진이 그 patch 를 받아들이고 문서가 유효하다', () => {
    let doc = docWithClip();
    doc = applyCommands(doc, [
      { type: 'updateClip', clipId: 'v1', patch: masksPatch([defaultPathMask()]) },
    ]);
    expect(clipOf(doc).mask?.shape).toBe('path');
    doc = applyCommands(doc, [
      {
        type: 'updateClip', clipId: 'v1',
        patch: masksPatch([defaultMask(), { ...defaultPathMask(), op: 'subtract' }]),
      },
    ]);
    expect(clipOf(doc).masks).toHaveLength(2);
    expect(clipOf(doc).mask).toBeUndefined();
    expect(() => validateDoc(doc)).not.toThrow();
  });

  it('기본 자유 마스크는 원이고 문서 검증을 통과한다', () => {
    const m = defaultPathMask();
    expect(m.shape).toBe('path');
    const parsed = parseMaskShape(m.d!)!;
    expect(parsed.pts).toHaveLength(4);
    expect(parsed.closed).toBe(true);
    const doc = applyCommands(docWithClip(), [
      { type: 'updateClip', clipId: 'v1', patch: masksPatch([m]) },
    ]);
    expect(() => validateDoc(doc)).not.toThrow();
  });

  it('모양 드롭다운에 자유 곡선이 있고, op 3종이 있다', () => {
    expect(MASK_SHAPE_OPTIONS.map((o) => o.value)).toEqual(['rect', 'circle', 'linear', 'path']);
    expect(MASK_OP_OPTIONS.map((o) => o.value)).toEqual(['add', 'subtract', 'intersect']);
  });

  it('모양 키프레임이 2개 이상이면 점 추가·삭제가 잠긴다', () => {
    const d = 'M 0,0 L 1,0 L 1,1 Z';
    expect(maskShapeLocked({ ...defaultPathMask(), d })).toBe(false);
    expect(maskShapeLocked({ ...defaultPathMask(), d, dKeys: [{ time: 0, d }] })).toBe(false);
    expect(
      maskShapeLocked({ ...defaultPathMask(), d, dKeys: [{ time: 0, d }, { time: 500, d }] }),
    ).toBe(true);
  });
});

// ── 펜 툴 편집 연산 ──────────────────────────────────────────────────────

const square = () => parseMaskShape('M 0,0 L 1,0 L 1,1 L 0,1 Z')!;

describe('펜 툴 — 점·핸들 조작', () => {
  it('점을 옮기면 그 점의 핸들도 같이 따라간다', () => {
    const m = parseMaskShape('M 0,0 C 0.2,0.2 0.8,0.8 1,1')!;
    const n = moveVertex(m, 0, 0.5, 0.5);
    expect(n.pts[0]).toMatchObject({ x: 0.5, y: 0.5 });
    expect(n.pts[0]!.hOut).toEqual({ x: 0.7, y: 0.7 });
  });

  it('핸들은 기본이 좌우 대칭, Alt 면 대칭이 깨진다', () => {
    const m = parseMaskShape('M 0,0 C 0.2,0 0.8,1 1,1')!;
    const withIn = { ...m, pts: m.pts.map((p, i) => (i === 0 ? { ...p, hIn: { x: -0.2, y: 0 } } : p)) };
    const sym = moveHandle(withIn, 0, 'hOut', 0.3, 0.1, false);
    expect(sym.pts[0]!.hIn).toEqual({ x: -0.3, y: -0.1 }); // 점(0,0) 기준 반대편
    const broken = moveHandle(withIn, 0, 'hOut', 0.3, 0.1, true);
    expect(broken.pts[0]!.hIn).toEqual({ x: -0.2, y: 0 }); // 그대로
  });

  it('점 삭제는 최소 2점을 남긴다', () => {
    const m = square();
    expect(deleteVertex(m, 1).pts).toHaveLength(3);
    const two = { closed: true, pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    expect(deleteVertex(two, 0).pts).toHaveLength(2);
  });

  it('더블클릭 — 꺾인점 ↔ 곡선점', () => {
    const m = square();
    const smooth = toggleSmooth(m, 1);
    expect(smooth.pts[1]!.hIn).toBeDefined();
    expect(smooth.pts[1]!.hOut).toBeDefined();
    const back = toggleSmooth(smooth, 1);
    expect(back.pts[1]!.hIn).toBeUndefined();
  });

  it('방향키 — 선택된 점만 / 선택이 없으면 전체', () => {
    const m = square();
    const one = nudge(m, 2, 0.01, 0);
    expect(one.pts[2]!.x).toBeCloseTo(1.01, 9);
    expect(one.pts[0]!.x).toBe(0);
    const all = nudge(m, null, 0.01, 0.02);
    expect(all.pts.map((p) => p.x)).toEqual([0.01, 1.01, 1.01, 0.01]);
    expect(all.pts.map((p) => p.y)).toEqual([0.02, 0.02, 1.02, 1.02]);
  });

  it('편집한 모양이 다시 유효한 d 로 나가고 왕복이 안정적이다', () => {
    const m = toggleSmooth(moveVertex(square(), 0, 0.1, 0.1), 0);
    const d = serializeMaskShape(m);
    const back = parseMaskShape(d)!;
    expect(serializeMaskShape(back)).toBe(d);
    const doc = applyCommands(docWithClip(), [
      { type: 'updateClip', clipId: 'v1', patch: masksPatch([{ ...defaultPathMask(), d }]) },
    ]);
    expect(() => validateDoc(doc)).not.toThrow();
  });
});

describe('편집기 되돌리기 — 문서 스택과 따로 논다', () => {
  it('undo/redo 가 편집기 안에서만 움직인다', () => {
    const h = new ShapeHistory(square());
    const moved = moveVertex(h.value, 0, 0.5, 0.5);
    h.push(moved);
    expect(h.value.pts[0]!.x).toBe(0.5);
    expect(h.undo()).toBe(true);
    expect(h.value.pts[0]!.x).toBe(0);
    expect(h.redo()).toBe(true);
    expect(h.value.pts[0]!.x).toBe(0.5);
    expect(h.undo()).toBe(true);
    expect(h.undo()).toBe(false); // 더 되돌릴 것이 없다
  });

  it('새 편집을 하면 redo 가 지워진다', () => {
    const h = new ShapeHistory(square());
    h.push(moveVertex(h.value, 0, 0.5, 0.5));
    h.undo();
    h.push(moveVertex(h.value, 1, 0.9, 0));
    expect(h.redo()).toBe(false);
  });

  it('스택은 100단계까지만 쌓인다 (드래그 한 번이 수백 번이라서)', () => {
    const h = new ShapeHistory(square());
    for (let i = 0; i < 250; i++) h.push(moveVertex(h.value, 0, i / 1000, 0));
    expect(h.depth).toBe(100);
  });
});

// ── F8 인스펙터 힌트 ────────────────────────────────────────────────────

describe('키네틱 타이포 인스펙터', () => {
  it('21종 전부 라벨이 있다', () => {
    expect(Object.keys(TEXT_ANIM_LABELS)).toHaveLength(21);
    expect(TEXT_ANIM_LABELS.springUp).toBe('탄력 등장');
    expect(TEXT_ANIM_LABELS.drawStroke).toBe('붓글씨 (획 그리기)');
    expect(TEXT_ANIM_UNIT_LABELS).toEqual({ all: '전체', line: '줄', word: '단어', char: '글자' });
  });

  it('단위 드롭다운은 유효한 조합만 보여 준다', () => {
    expect(textAnimUnitOptions('typewriter').map((o) => o.value)).toEqual(['char']);
    expect(textAnimUnitOptions('wordHighlight').map((o) => o.value)).toEqual(['word']);
    expect(textAnimUnitOptions('drawStroke').map((o) => o.value)).toEqual(['all', 'char']);
    expect(textAnimUnitOptions('slideUp')).toHaveLength(4);
  });

  it('단위 개수 — 줄·단어·글자', () => {
    expect(textUnitCount('가나\n다', 'all')).toBe(1);
    expect(textUnitCount('가나\n다', 'line')).toBe(2);
    expect(textUnitCount('하나 둘 셋', 'word')).toBe(3);
    expect(textUnitCount('가 나', 'char')).toBe(2); // 공백은 안 센다
  });

  it('시차가 자동으로 줄면 «실제 적용된 값»을 알려 준다', () => {
    const anim: TextAnim = { type: 'slideUp', duration: 600, unit: 'char', staggerMs: 30 };
    const text = '가'.repeat(40);
    const hint = textAnimHint(anim, text, 30);
    expect(hint.compressed).toBe(true);
    expect(hint.applied).toBeCloseTo(600 * 0.6 / 39, 9);
  });

  it('시차가 한 프레임보다 짧으면 노란 경고를 준다 (막지는 않는다)', () => {
    const anim: TextAnim = { type: 'slideUp', duration: 5000, unit: 'char', staggerMs: 20 };
    expect(textAnimHint(anim, '가나다', 24).warning).toContain('한 프레임');
    expect(textAnimHint(anim, '가나다', 60).warning).toBeNull();
  });

  it('unit 이 없으면(=전체) 시차도 경고도 없다 — v1 문서와 같다', () => {
    const hint = textAnimHint({ type: 'fade', duration: 500 }, '가나다', 30);
    expect(hint.applied).toBe(0);
    expect(hint.warning).toBeNull();
    expect(hint.compressed).toBe(false);
  });
});

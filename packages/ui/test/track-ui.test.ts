// W8 F10 — 마스크 추적 UI 의 순수 로직.
//
// 여기서 보는 것은 「사용자가 보는 것이 맞는가」다: 어느 잡이 이 클립 것인지, 재생헤드가
// 놓친 구간 안에 있는지. 추적 자체(파이썬)와 판정(classifyTrack)은 각 패키지의 테스트가 본다.
import { describe, expect, it } from 'vitest';
import type { JobInfo } from '../src/api.js';
import { gapAt, trackActions, trackJobOf } from '../src/components/sections/VideoSection.js';

const job = (over: Partial<JobInfo>): JobInfo =>
  ({ id: 'j', type: 'track', status: 'done', progress: 1, ...over }) as JobInfo;

describe('trackJobOf', () => {
  it('이 클립의 추적 잡만 고른다', () => {
    const jobs: Record<string, JobInfo> = {
      a: job({ id: 'a', key: 'other:track' }),
      b: job({ id: 'b', key: 'c1:track' }),
      c: job({ id: 'c', type: 'render' }),
    };
    expect(trackJobOf(jobs, 'c1')?.id).toBe('b');
    expect(trackJobOf(jobs, '없음')).toBeUndefined();
  });

  it('같은 클립의 잡이 여럿이면 마지막 것을 쓴다 (다시 추적한 결과가 보여야 한다)', () => {
    const jobs: Record<string, JobInfo> = {
      old: job({ id: 'old', key: 'c1:track' }),
      neo: job({ id: 'neo', key: 'c1:track' }),
    };
    expect(trackJobOf(jobs, 'c1')?.id).toBe('neo');
  });

  it('추적이 아닌 잡은 key 가 같아도 무시한다', () => {
    expect(trackJobOf({ x: job({ type: 'matchStats', key: 'c1:track' }) }, 'c1')).toBeUndefined();
  });
});

describe('gapAt — 재생헤드가 놓친 구간 안인가', () => {
  const gaps = [
    { startMs: 1000, endMs: 2000 },
    { startMs: 4000, endMs: 4500 },
  ];

  it('구간 안이면 그 구간을 준다 (경계 포함)', () => {
    expect(gapAt(gaps, 1500)).toEqual(gaps[0]);
    expect(gapAt(gaps, 1000)).toEqual(gaps[0]);
    expect(gapAt(gaps, 2000)).toEqual(gaps[0]);
    expect(gapAt(gaps, 4200)).toEqual(gaps[1]);
  });

  it('구간 밖이면 undefined', () => {
    expect(gapAt(gaps, 0)).toBeUndefined();
    expect(gapAt(gaps, 3000)).toBeUndefined();
    expect(gapAt(gaps, 9000)).toBeUndefined();
  });

  it('결과가 아직 없으면 undefined (추적 전)', () => {
    expect(gapAt(undefined, 100)).toBeUndefined();
    expect(gapAt([], 100)).toBeUndefined();
  });
});

describe('trackActions — 추적 버튼 세 개', () => {
  const at = (ms: number) => Object.fromEntries(trackActions(ms).map((a) => [a.key, a]));

  it('세 개를 «처음부터 · 여기서 다시 · 여기서 앞뒤로» 순서로 낸다', () => {
    expect(trackActions(1200).map((a) => a.key)).toEqual(['fromStart', 'fromHere', 'bothWays']);
    expect(trackActions(1200).map((a) => a.label)).toEqual([
      '처음부터 추적',
      '여기서 다시 추적',
      '여기서 앞뒤로 추적',
    ]);
  });

  it('「처음부터 추적」은 클립 처음에서 앞으로 — 재생헤드와 무관하게 언제나 누를 수 있다', () => {
    expect(at(0).fromStart).toMatchObject({ startMs: 0, direction: 'forward', disabled: false });
    expect(at(4000).fromStart).toMatchObject({ startMs: 0, direction: 'forward', disabled: false });
  });

  it('「여기서 다시 추적」은 재생헤드가 기준이고 방향은 forward 다 — 앞쪽 키프레임을 보존한다', () => {
    expect(at(1200).fromHere).toMatchObject({ startMs: 1200, direction: 'forward', disabled: false });
    expect(at(1200).fromHere!.title).toContain('앞쪽 키프레임은 그대로 둡니다');
  });

  it('「여기서 앞뒤로 추적」만 both 다 — 양방향은 «명시적으로» 켠다', () => {
    expect(at(1200).bothWays).toMatchObject({ startMs: 1200, direction: 'both', disabled: false });
    expect(trackActions(1200).filter((a) => a.direction === 'both')).toHaveLength(1);
  });

  it('재생헤드가 클립 처음(0)이면 뒤의 둘은 잠긴다 — 「처음부터」와 같은 일이 된다', () => {
    expect(at(0).fromHere!.disabled).toBe(true);
    expect(at(0).bothWays!.disabled).toBe(true);
    expect(at(1).bothWays!.disabled).toBe(false);
  });

  it('클립 끝에 서 있어도 앞뒤로 추적은 누를 수 있다 (뒤로만 도는 정상 요청이다)', () => {
    expect(at(5000).bothWays).toMatchObject({ startMs: 5000, direction: 'both', disabled: false });
  });
});

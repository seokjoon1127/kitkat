// 프리뷰 v2 — 프레임 캐시 순수 로직 (LRU 축출 순서 · 캐시 키 양자화)
import { describe, expect, it, vi } from 'vitest';
import { LruCache, frameCacheKey, quantizeMs } from '../src/preview/cache.js';

describe('LruCache', () => {
  it('용량을 넘으면 가장 오래 안 쓴 것부터 버린다', () => {
    const evicted: string[] = [];
    const c = new LruCache<string, number>(3, (k) => evicted.push(k));
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('d', 4);
    expect(evicted).toEqual(['a']);
    expect(c.keys()).toEqual(['b', 'c', 'd']);
  });

  it('get 은 사용 순서를 갱신해 축출 대상을 바꾼다', () => {
    const evicted: string[] = [];
    const c = new LruCache<string, number>(3, (k) => evicted.push(k));
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.get('a')).toBe(1); // a 를 최신으로
    c.set('d', 4);
    expect(evicted).toEqual(['b']);
    expect(c.keys()).toEqual(['c', 'a', 'd']);
  });

  it('peek 는 순서를 건드리지 않는다', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.peek('a')).toBe(1);
    expect(c.keys()).toEqual(['a', 'b']);
  });

  it('같은 키를 덮어쓰면 이전 값을 해제하고 크기는 그대로다', () => {
    const onEvict = vi.fn();
    const c = new LruCache<string, number>(2, onEvict);
    c.set('a', 1);
    c.set('a', 9);
    expect(c.size).toBe(1);
    expect(c.get('a')).toBe(9);
    expect(onEvict).toHaveBeenCalledWith('a', 1);
  });

  it('clear 는 모든 값에 해제 콜백을 부른다', () => {
    const evicted: string[] = [];
    const c = new LruCache<string, number>(5, (k) => evicted.push(k));
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(evicted).toEqual(['a', 'b']);
    expect(c.size).toBe(0);
  });
});

describe('캐시 키 양자화', () => {
  it('프레임 간격으로 내림 양자화한다 (30fps)', () => {
    const step = 1000 / 30; // 33.333…
    expect(quantizeMs(0, step)).toBe(0);
    expect(quantizeMs(20, step)).toBe(0);
    expect(quantizeMs(34, step)).toBe(33);
    expect(quantizeMs(66.6666667, step)).toBe(67);
    expect(quantizeMs(99, step)).toBe(67);
    expect(quantizeMs(100, step)).toBe(100);
  });

  it('같은 프레임 안의 시각들은 같은 키가 된다', () => {
    const step = 1000 / 30;
    const a = frameCacheKey('/media/a.mp4', 100.1, step);
    const b = frameCacheKey('/media/a.mp4', 132.9, step);
    const c = frameCacheKey('/media/a.mp4', 133.4, step);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe('/media/a.mp4@100');
  });

  it('음수·비정상 값은 0 으로, step 0 이면 정수 반올림만 한다', () => {
    expect(quantizeMs(-5, 33)).toBe(0);
    expect(quantizeMs(Number.NaN, 33)).toBe(0);
    expect(quantizeMs(12.6, 0)).toBe(13);
  });

  it('src 가 다르면 키도 다르다', () => {
    const step = 1000 / 30;
    expect(frameCacheKey('/a.mp4', 100, step)).not.toBe(frameCacheKey('/b.mp4', 100, step));
  });
});

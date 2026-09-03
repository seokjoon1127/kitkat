// W8 F17 리뷰 #12 — 「잡이 죽으면 자식 프로세스도 죽는다」를 **호출 하나하나에 실어 나르지 않고** 보장한다.
//
// 처음엔 RunOpts.signal 을 함수 서명마다 뚫어 넘겼다(derive → runEncodePass → runFfmpegProgress …).
// 그런데 ffmpeg 을 부르는 자리가 media 안에만 20곳이 넘고, lanczos 폴백처럼 opts 가 손에 없는
// 헬퍼도 있다. 한 곳이라도 빠지면 그 프로세스는 다시 «살아남는다» — 빠뜨린 자리가 곧 구멍이다.
//
// 그래서 잡 실행기가 **비동기 컨텍스트**(AsyncLocalStorage)에 신호를 걸어 두고, execa 를 부르는 곳이
// 명시적 signal 이 없으면 여기서 꺼내 쓴다. 잡 안에서 도는 모든 자식 프로세스가 자동으로 덮인다.
// 명시적으로 넘긴 signal 이 있으면 그것이 우선한다.
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<AbortSignal>();

/** 잡 실행기가 잡 함수를 이 안에서 돌린다. 안에서 띄우는 자식 프로세스는 전부 이 신호를 물려받는다. */
export function runWithJobSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return store.run(signal, fn);
}

/** 지금 도는 잡의 취소 신호. 잡 밖(테스트·스크립트)에서는 undefined. */
export function currentJobSignal(): AbortSignal | undefined {
  return store.getStore();
}

/** 명시 signal 이 있으면 그것, 없으면 잡 컨텍스트의 것. */
export function effectiveSignal(explicit?: AbortSignal): AbortSignal | undefined {
  return explicit ?? store.getStore();
}

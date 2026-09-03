// W8 F17 리뷰 #1 — «스키마에 없는 필드» 찾기.
//
// ## 왜 필요한가
// Zod 의 `z.object()` 는 모르는 키를 **조용히 벗겨 낸다**(거절하지 않는다). 그래서
// `safeParse` 로 「맞는지」만 보고 원본을 그대로 저장하면, 없는 필드가 파일에 살아남는다.
// 실제로 그렇게 됐다 — 이미지 클립에 `chromaKey` 를 넣으면 200 이 나오고 문서에도 보이는데
// 렌더는 아무것도 안 했다(그때는 스키마에 그 필드가 없었다).
//
// 에이전트가 쓰는 API 에서 이건 제일 나쁜 실패다: **오타를 내도, 없는 기능을 켜도, 에러가 없다.**
//
// ## 방법
// 스키마마다 `.strict()` 를 붙이는 대신, 「원본」과 「스키마가 벗겨 낸 결과」를 나란히 걸어
// 원본에만 있는 키의 경로를 모은다. 스키마 30여 개를 하나도 안 건드리고 **모든 층위**를 잡는다.
// (`.strict()` 는 빠뜨린 객체 하나가 곧 구멍이다.)

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `original` 에는 있는데 `parsed`(Zod 가 벗겨 낸 결과)에는 없는 키의 경로 목록.
 * 값이 `undefined` 인 키는 세지 않는다 — JSON 에 실리지 않으므로 «없는 것»과 같다.
 *
 * 경로 표기는 Zod 이슈와 같다: `tracks.0.clips.2.chromaKey`
 */
export function findUnknownKeys(original: unknown, parsed: unknown, base = ''): string[] {
  const out: string[] = [];
  walk(original, parsed, base, out);
  return out;
}

function walk(o: unknown, p: unknown, base: string, out: string[]): void {
  if (Array.isArray(o)) {
    if (!Array.isArray(p)) return;
    for (let i = 0; i < o.length; i++) walk(o[i], p[i], base ? `${base}.${i}` : String(i), out);
    return;
  }
  if (!isPlainObject(o)) return;
  if (!isPlainObject(p)) return;
  for (const key of Object.keys(o)) {
    if (o[key] === undefined) continue;
    const path = base ? `${base}.${key}` : key;
    if (!(key in p)) {
      out.push(path);
      continue;
    }
    walk(o[key], p[key], path, out);
  }
}

/** 사람이 읽는 한 줄. 3개까지 보여 주고 나머지는 개수로. */
export function describeUnknownKeys(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(', ');
  const rest = paths.length > 3 ? ` 외 ${paths.length - 3}개` : '';
  return `스키마에 없는 필드: ${shown}${rest}`;
}

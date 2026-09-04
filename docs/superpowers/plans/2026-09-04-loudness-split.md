# 음량 맞춤(loudness)을 음색 손질(voice)에서 떼어내기 — 구현계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 목소리용 EQ 체인을 걸지 않고도 클립의 라우드니스를 목표 LUFS 에 맞출 수 있게 한다 — 배경음악에 「음량만」 맞추기.

**Architecture:** 지금 2패스 `loudnorm`(음량 맞춤)은 `spec.voice` 안에 들어 있어서, 목소리 프리셋을 켜야만 돌고 프리셋을 끄면(`off`) 같이 꺼진다. `loudness` 를 `ClipSource`·`AudioClipSource` 의 독립 필드로 올리고, `deriveMedia` 의 loudnorm 게이트를 `spec.voice` 대신 `spec.loudness` 로 옮긴다. `voice` 는 EQ·컴프·리버브만 담당하게 남는다. LRA(라우드니스 폭) 은 사용자 노브로 열지 않고 media 가 정한다 — voice 가 걸려 있으면 프리셋 값(11·7), 없으면 음악용 20.

**Tech Stack:** TypeScript(ESM) · zod · vitest · ffmpeg `loudnorm`(2패스) · npm workspaces

**Spec:** 이 문서 자체. 「배경」과 「설계 결정」 절이 spec 이고 그 아래가 plan 이다 — 두 문서로 쪼개면 실행자가 둘 다 안 읽는다.

## Global Constraints

- **`voice.targetLufs` 를 삭제하지 않는다.** zod 스키마에 남겨 옛 프로젝트 파일이 그대로 열리게 한다. 다만 UI 는 더 이상 쓰지 않는다.
- **`sourceKey` 의 기존 조각 문자열을 바꾸지 않는다.** `packages/schema/src/derive.ts:96` 주석의 계약이다 — 기존 조각을 건드리면 이미 구워 둔 모든 파생 파일이 죽고 프로젝트마다 재인코딩이 돈다. 새 조각은 **맨 뒤에만 덧붙인다.**
- **트루피크는 노브를 열지 않는다.** `VOICE_TRUE_PEAK_DB = -1.0` 를 그대로 쓴다 (아래 「안 하는 것」 참조).
- **한국어 주석.** 이 레포의 주석은 전부 한국어이고 「왜 이렇게 했는가」를 적는다. 「무엇을 하는가」만 적은 주석은 리뷰에서 반려한다.
- 테스트는 각 패키지에서 `npm test -w @kitkat/<패키지>` 로 돌린다. 전체는 루트에서 `npm test`.
- 커밋 메시지는 한국어 한 줄 + 필요하면 본문.

---

## 배경 — 왜 고치는가 (실측)

2026-09-04 실측. 4초 음악 클립(`bgm_a.mp3`, 원본 −18.5 LUFS)에 목표 −24 LUFS 를 걸었다.

| 설정 | 결과 라우드니스 | 목표 −24 에 맞았나 |
|---|---|---|
| 아무것도 안 함 | −18.5 LUFS | ❌ |
| `voice.preset: 'off'`, `targetLufs: -24` | −18.5 LUFS | ❌ **아무 일도 안 일어난다** |
| `voice.preset: 'broadcast'`, `targetLufs: -24` | −23.6 LUFS | ✅ 맞음 |

그런데 `broadcast` 를 걸면 목소리용 필터가 음악에 같이 먹는다. 같은 음악에 `voiceChain('broadcast')` 만 걸고 대역별로 쟀다:

| 대역 | 그냥 | 목소리 체인 적용 | 차이 |
|---|---|---|---|
| 저음 (200Hz 아래) | −17.6 dB | −23.8 dB | **−6.2 dB** |
| 고음 (6kHz 위) | −44.3 dB | −38.7 dB | **+5.6 dB** |

원인은 두 군데다.

1. **`packages/server/src/routes/commands.ts:143`** — `if (source.voice && source.voice.preset !== 'off')`. loudnorm 이 이 `if` 블록 «안» 에 있어서 프리셋을 끄면 음량 맞춤까지 같이 꺼진다.
2. **`packages/media/src/derive.ts:371` `voiceChain()`** — 프리셋을 켜면 `highpass=f=80` · `equalizer=f=200:g=-3` · `equalizer=f=400:g=-2` · `equalizer=f=3500:g=3` · `highshelf=f=10000:g=2` 가 통째로 붙는다. 말소리엔 맞지만 음악은 저음이 빠지고 얇아진다.

캡컷의 「음량 정규화」도, 오픈소스 표준인 `ffmpeg-normalize` 도 **게인만 조정하고 음색은 건드리지 않는다.** 킷캣에 없는 것은 엔진이 아니라 그 «분리» 다.

## 설계 결정

### 결정 1 — `loudness` 는 `voice` 와 형제 필드다

```ts
export type LoudnessSpec = { targetLufs: number };
```

`ClipSource`(영상 클립)·`AudioClipSource`(오디오 클립) 양쪽에 `loudness?: LoudnessSpec` 를 단다. `voice` 가 있든 없든 독립적으로 켜고 끈다. 그래서 이제 네 조합이 전부 가능하다:

| `voice` | `loudness` | 결과 |
|---|---|---|
| 없음 | 없음 | 오디오를 안 건드린다 |
| 없음 | `-24` | **새로 되는 것** — 음량만 −24 로. 음악용 |
| `broadcast` | 없음 | 음색만 다듬는다. 음량은 원본 그대로 |
| `broadcast` | `-16` | 다듬고 −16 으로. 이것도 새로 되는 것 (지금은 `voice.targetLufs` 로 묶여 있어 프리셋 없이는 못 쓴다) |

### 결정 2 — LRA 는 사용자 노브가 아니라 media 가 정한다

`loudnorm` 의 `LRA` 는 「허용할 음량 폭」이다. **원본의 폭이 이 값보다 넓으면 loudnorm 이 혼자 판단해서 「동적 모드」로 바꿔** 곡 안의 여린 데를 올리고 센 데를 눌러 평평하게 만든다. 지금 값은 목소리 기준(`broadcast` 11, `podcast` 7)이라 음악엔 그대로 쓰면 안 된다.

노브를 하나 더 여는 대신 media 가 정한다:

```ts
export const MUSIC_LRA = 20;
export function loudnessLra(spec: DeriveSpec): number {
  return spec.voice ? voiceLra(spec.voice.preset) : MUSIC_LRA;
}
```

근거: voice 체인에는 이미 `acompressor` 가 들어 있어 폭이 좁혀진 상태다 — 그래서 11 이 맞는다. voice 가 없으면 아무것도 안 좁혔으니 넉넉히 줘서 「상수 게인 1번」(`normalization_type: "linear"`) 에 머물게 한다.

### 결정 3 — 옛 프로젝트 호환은 `normalizeLoudness()` 한 곳에서

`voice.targetLufs` 를 쓰던 프로젝트 파일이 이미 있다. 스키마에서 지우지 않고, 읽는 쪽에서 한 번 변환한다.

```ts
export function normalizeLoudness(
  src: { voice?: VoiceSpec; loudness?: LoudnessSpec },
): LoudnessSpec | undefined
```

`loudness` 가 있으면 그것을, 없고 `voice.preset !== 'off'` 면 `voice.targetLufs ?? -14` 를 쓴다. 둘 다 있으면 `loudness` 가 이긴다. 서버(`fillSourceSpec`)가 이 함수 하나만 부른다.

### 결정 4 — `sourceKey` 는 조각을 «덧붙이기만» 한다

`voicePart()` 를 건드리지 않는다(`targetLufs` 를 거기서 빼면 기존 문서의 키가 전부 바뀌어 재인코딩이 돈다). `src.loudness` 가 **명시적으로 있을 때만** 맨 뒤에 `loud=…` 조각을 붙인다.

부작용 하나를 알고 간다: `{voice:{preset:'broadcast',targetLufs:-16}}` 와 `{voice:{preset:'broadcast'},loudness:{targetLufs:-16}}` 는 같은 파일을 굽는데 키가 다르다 → 사용자가 UI 에서 옛 프로젝트를 열어 손대는 순간 그 클립이 한 번 다시 구워진다. **한 번뿐이고 결과는 같다.** 이걸 피하려면 정규화한 형태로 키를 만들어야 하는데, 그러면 기존 문서 키가 전부 바뀌어 훨씬 큰 재인코딩이 돈다. 작은 쪽을 택한다.

### 안 하는 것 (YAGNI)

- **트루피크를 목표별로 다르게 주기.** `LOUDNESS_TARGETS` 의 `google-ads` 는 `truePeakDb: -2` 인데 `derive.ts` 는 `-1.0` 을 하드코딩한다. 실제 불일치이지만 이번 작업 범위 밖이다 — 별도 티켓으로 남긴다. 이번 계획은 트루피크를 건드리지 않는다.
- **음악용 EQ 프리셋.** 만들지 않는다. 캡컷도 오픈소스도 안 만든다. 음악에 필요한 건 EQ 를 «안 거는» 것이다.
- **`loudness` 를 트랙·프로젝트 단위로 거는 것.** 지금은 클립 단위(`source`)만. 트랙 단위는 다른 설계다.

## 파일 구조

| 파일 | 책임 | 변경 |
|---|---|---|
| `packages/schema/src/index.ts` | `LoudnessSpec` 타입 · `LoudnessSchema` zod · 두 `ClipSource` 에 필드 추가 | 수정 |
| `packages/schema/src/derive.ts` | `loudnessPart()` sourceKey 조각 · `normalizeLoudness()` | 수정 |
| `packages/schema/test/source-key-w8.test.ts` | 키가 갈리는지 | 수정 |
| `packages/schema/test/loudness.test.ts` | `normalizeLoudness` 단위 테스트 | 수정 |
| `packages/media/src/derive.ts` | `LoudnessDeriveSpec` · `MUSIC_LRA` · `loudnessLra()` · `loudnorm*()` 시그니처 · `deriveMedia` 게이트 6곳 | 수정 |
| `packages/media/test/derive-w8.test.ts` | 필터 문자열 단위 + 실제 ffmpeg 대역 측정 | 수정 |
| `packages/server/src/routes/commands.ts` | `fillSourceSpec` 이 `spec.loudness` 를 채운다 | 수정 |
| `packages/ui/src/components/sections/SourceSection.tsx` | 목표 LUFS 조작을 프리셋 밖으로 | 수정 |

새로 만드는 파일은 없다. 이 레포는 큰 파일 하나에 관련 코드를 모으는 방식이고, 그 방식을 따른다.

---

### Task 1: 스키마 — `loudness` 를 1급 필드로

**Files:**
- Modify: `packages/schema/src/index.ts` (타입 `ClipSource`/`AudioClipSource`, zod `ClipSourceSchema`/`AudioClipSourceSchema`, export 목록)
- Modify: `packages/schema/src/derive.ts` (`loudnessPart`, `sourceKey`, `normalizeLoudness`)
- Test: `packages/schema/test/source-key-w8.test.ts`, `packages/schema/test/loudness.test.ts`

**Interfaces:**
- Consumes: 기존 `VoiceSpec`, `DEFAULT_TARGET_LUFS`(-14), `round4`, `fnv1a32`
- Produces:
  - `export type LoudnessSpec = { targetLufs: number }`
  - `export const LoudnessSchema: z.ZodType<LoudnessSpec>`
  - `export function normalizeLoudness(src: { voice?: VoiceSpec; loudness?: LoudnessSpec }): LoudnessSpec | undefined`
  - `ClipSource.loudness?: LoudnessSpec`, `AudioClipSource.loudness?: LoudnessSpec`

- [ ] **Step 1: `normalizeLoudness` 의 실패하는 테스트를 쓴다**

`packages/schema/test/loudness.test.ts` 맨 아래에 붙인다. 파일 위쪽 import 에 `normalizeLoudness` 를 추가한다.

```ts
describe('normalizeLoudness — voice.targetLufs 를 쓰던 옛 문서 호환', () => {
  it('loudness 가 있으면 그대로 쓴다', () => {
    expect(normalizeLoudness({ loudness: { targetLufs: -24 } })).toEqual({ targetLufs: -24 });
  });

  it('loudness 가 없고 voice 가 켜져 있으면 voice.targetLufs 를 옮겨 온다', () => {
    expect(normalizeLoudness({ voice: { preset: 'broadcast', targetLufs: -16 } }))
      .toEqual({ targetLufs: -16 });
  });

  it('voice 만 있고 targetLufs 를 안 적었으면 기본값 -14', () => {
    expect(normalizeLoudness({ voice: { preset: 'warm' } }))
      .toEqual({ targetLufs: DEFAULT_TARGET_LUFS });
  });

  it("preset:'off' 는 음량도 안 맞춘다 — 옛 동작 그대로", () => {
    expect(normalizeLoudness({ voice: { preset: 'off', targetLufs: -24 } })).toBeUndefined();
  });

  it("preset:'off' 여도 loudness 가 있으면 맞춘다 — 이것이 이번에 고치는 것", () => {
    expect(normalizeLoudness({ voice: { preset: 'off' }, loudness: { targetLufs: -24 } }))
      .toEqual({ targetLufs: -24 });
  });

  it('둘 다 있으면 loudness 가 이긴다', () => {
    expect(normalizeLoudness({ voice: { preset: 'broadcast', targetLufs: -16 }, loudness: { targetLufs: -24 } }))
      .toEqual({ targetLufs: -24 });
  });

  it('아무것도 없으면 undefined', () => {
    expect(normalizeLoudness({})).toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -w @kitkat/schema`
Expected: FAIL — `normalizeLoudness is not exported` 또는 `is not a function`

- [ ] **Step 3: 타입과 zod 를 추가한다**

`packages/schema/src/index.ts` — `VoiceSpec` 타입 정의 바로 아래(현재 241행 근처)에 붙인다:

```ts
/**
 * 음량 맞춤 (라우드니스 정규화). **`voice`(음색 손질) 와 별개다.**
 *
 * 목소리 프리셋을 켜지 않고도 걸 수 있어야 한다 — 배경음악에 `broadcast` 를 걸면
 * 80Hz 아래가 잘리고 200·400Hz 가 깎여 저음이 −6.2dB 빠진다(2026-09-04 실측).
 * 음악에 필요한 것은 EQ 를 «안 거는» 음량 맞춤이다.
 */
export type LoudnessSpec = {
  targetLufs: number;   // -30..-9. LOUDNESS_TARGETS 에서 고르거나 직접 지정
};
```

`ClipSource` 타입(현재 173행 `voice?: VoiceSpec;` 다음 줄):

```ts
  loudness?: LoudnessSpec;      // 음량 맞춤 (2패스 loudnorm) — voice 와 독립
```

`AudioClipSource` 타입(현재 248행 `voice?: VoiceSpec;` 다음 줄)에 같은 줄을 붙인다.

zod — `VoiceSchema` 정의 바로 아래:

```ts
/** -30..-9 LUFS. 트루피크(-1.0 dBTP)는 노브를 열지 않는다 — VOICE_TRUE_PEAK_DB 참조. */
export const LoudnessSchema = z.object({
  targetLufs: z.number().min(-30).max(-9),
});
```

`ClipSourceSchema` 와 `AudioClipSourceSchema` 양쪽의 `voice: VoiceSchema.optional(),` 다음 줄에:

```ts
  loudness: LoudnessSchema.optional(),
```

- [ ] **Step 4: `normalizeLoudness` 를 구현한다**

`packages/schema/src/derive.ts` — `DEFAULT_TARGET_LUFS` 선언(현재 87행) 바로 아래. 파일 위쪽 `import type` 목록에 `LoudnessSpec` 을 추가한다.

```ts
/**
 * 옛 문서 호환 — 「음량 맞춤」은 원래 `voice.targetLufs` 안에 갇혀 있었다.
 * 그래서 프리셋을 끄면(`off`) 음량 맞춤까지 같이 꺼졌다. 이제 `loudness` 가 제자리다.
 *
 * 읽는 쪽은 여기 하나만 부른다 — 서버·UI·sourceKey 가 각자 규칙을 갖게 두면 갈린다.
 * `off` 에서 undefined 를 내는 것은 «옛 동작을 그대로 두기» 위해서다: 옛 문서에서
 * `preset:'off'` 는 「오디오를 건드리지 마라」였고, 그 문서를 열었다고 갑자기
 * 음량이 바뀌면 안 된다. 새로 켜려면 `loudness` 를 명시해야 한다.
 */
export function normalizeLoudness(
  src: { voice?: VoiceSpec; loudness?: LoudnessSpec },
): LoudnessSpec | undefined {
  if (src.loudness) return src.loudness;
  if (src.voice && src.voice.preset !== 'off') {
    return { targetLufs: src.voice.targetLufs ?? DEFAULT_TARGET_LUFS };
  }
  return undefined;
}
```

`packages/schema/src/index.ts` 의 re-export 목록(현재 906행 근처, `DEFAULT_TARGET_LUFS` 가 있는 줄)에 `normalizeLoudness` 를 추가한다.

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `npm test -w @kitkat/schema`
Expected: PASS — `normalizeLoudness` 7개 전부 통과. 기존 테스트도 전부 통과(아직 sourceKey 를 안 건드렸으므로).

- [ ] **Step 6: sourceKey 의 실패하는 테스트를 쓴다**

`packages/schema/test/source-key-w8.test.ts` 의 「필드를 바꾸면 키가 갈린다」 표(현재 90~94행의 `'voice.preset'` 등이 있는 객체)에 두 줄을 추가한다:

```ts
  'loudness 추가': (s) => { s.loudness = { targetLufs: -24 }; },
  'loudness.targetLufs': (s) => { s.loudness = { targetLufs: -16 }; },
```

그리고 파일 아래쪽에 독립 테스트를 붙인다:

```ts
describe('loudness — 새 조각은 맨 뒤에만 붙는다', () => {
  it('loudness 만 있어도 키가 나온다 — voice 없이 굽는 새 경우', () => {
    const k = sourceKey(vclip({ loudness: { targetLufs: -24 } }));
    expect(k).toMatch(/^s[0-9a-f]{8}$/);
    expect(k).not.toBe(sourceKey(vclip({ loudness: { targetLufs: -23 } })));
  });

  it('voice.targetLufs 와 loudness.targetLufs 는 서로 다른 키다 (알고 가는 부작용)', () => {
    expect(sourceKey(vclip({ voice: { preset: 'broadcast', targetLufs: -16 } })))
      .not.toBe(sourceKey(vclip({ voice: { preset: 'broadcast' }, loudness: { targetLufs: -16 } })));
  });
});
```

**「기존 문서의 키가 안 바뀐다」는 새로 쓰지 않는다** — 이 파일 157~160행에 이미 고정값 테스트가 있다 (`s0460895d`·`sca752f1d`·`s6560b59b`). 그게 그대로 통과하는지가 곧 계약 검증이다. 만약 그 셋 중 하나라도 깨지면 `voicePart` 나 기존 조각을 건드린 것이므로 **되돌린다.**

- [ ] **Step 7: 실패를 확인한다**

Run: `npm test -w @kitkat/schema`
Expected: FAIL — `loudness 추가` 케이스가 「키가 갈린다」를 만족하지 못한다 (아직 sourceKey 가 loudness 를 안 읽으므로 같은 키가 나온다)

- [ ] **Step 8: sourceKey 에 조각을 덧붙인다**

`packages/schema/src/derive.ts` — `voicePart` 아래에 추가:

```ts
/** 음량 맞춤 조각. **`voicePart` 는 건드리지 않는다** — 기존 문서의 키를 지키려면
 *  새 조각을 맨 뒤에 덧붙이는 수밖에 없다(이 파일 sourceKey 주석의 계약). */
function loudnessPart(l: LoudnessSpec): string {
  return `loud=${round4(l.targetLufs)}`;
}
```

`sourceKey` 본문 — `if (src.voice) parts.push(voicePart(src.voice));` **다음 줄**에:

```ts
  if (src.loudness) parts.push(loudnessPart(src.loudness));
```

- [ ] **Step 9: 통과를 확인한다**

Run: `npm test -w @kitkat/schema`
Expected: PASS — 전부 통과

- [ ] **Step 10: 커밋**

```bash
git add packages/schema/src/index.ts packages/schema/src/derive.ts packages/schema/test/loudness.test.ts packages/schema/test/source-key-w8.test.ts
git commit -m "스키마: loudness 를 voice 와 형제 필드로 올린다"
```

---

### Task 2: media — loudnorm 을 voice 에서 떼어낸다 (순수 함수)

**Files:**
- Modify: `packages/media/src/derive.ts:76-94` (타입), `:333-420` (프리셋·체인·loudnorm 함수)
- Modify: `packages/media/src/index.ts` (re-export)
- Test: `packages/media/test/derive-w8.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `LoudnessSpec` (개념만 — media 는 schema 에 의존하지 않으므로 자기 타입을 갖는다)
- Produces:
  - `export type LoudnessDeriveSpec = { targetLufs: number }`
  - `DeriveSpec.loudness?: LoudnessDeriveSpec`
  - `export const MUSIC_LRA = 20`
  - `export function loudnessLra(spec: DeriveSpec): number`
  - `loudnormMeasure(targetLufs: number, lra: number, statsName: string): string` (모듈 내부)
  - `loudnormApply(targetLufs: number, lra: number, m: LoudnormStats, statsName: string): string` (모듈 내부)
- 이 태스크는 `deriveMedia` 본문을 **건드리지 않는다.** 배선은 Task 3.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/media/test/derive-w8.test.ts` 의 `describe('voiceChain — alimiter 자동 레벨링 함정')` 블록 뒤에 붙인다. 파일 위쪽 import 에 `loudnessLra`, `MUSIC_LRA` 를 추가한다.

```ts
describe('loudnessLra — 음악에 목소리용 LRA 를 쓰면 안 된다', () => {
  it('voice 가 있으면 프리셋 LRA 를 쓴다 — 컴프가 이미 폭을 좁혔으므로', () => {
    expect(loudnessLra({ voice: { preset: 'broadcast' }, loudness: { targetLufs: -14 } })).toBe(11);
    expect(loudnessLra({ voice: { preset: 'podcast' }, loudness: { targetLufs: -14 } })).toBe(7);
  });

  it('voice 가 없으면 음악용 20 — 좁게 주면 loudnorm 이 동적 모드로 바뀌어 곡을 평평하게 만든다', () => {
    expect(loudnessLra({ loudness: { targetLufs: -24 } })).toBe(MUSIC_LRA);
    expect(MUSIC_LRA).toBe(20);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -w @kitkat/media -- derive-w8`
Expected: FAIL — `loudnessLra is not exported`

- [ ] **Step 3: 타입과 `loudnessLra` 를 추가한다**

`packages/media/src/derive.ts` — `VoiceDeriveSpec`(현재 77~81행)에서 `targetLufs` 를 **지우고** 그 아래에 새 타입을 만든다. 여기서 같이 지우는 이유: 남겨 두면 Step 1 의 테스트가 `voice: { preset: 'broadcast' }` 를 넘길 때 「targetLufs 가 없다」로 타입 오류가 난다.

```ts
export type VoiceDeriveSpec = {
  preset: VoicePresetId;
  reverb?: { irAbs: string; wet: number };         // wet 0..1
};

/** 음량 맞춤. voice 와 «독립» 이다 — 목소리 프리셋 없이도 걸 수 있어야 한다. */
export type LoudnessDeriveSpec = { targetLufs: number };
```

`DeriveSpec`(현재 83행) 의 `voice?: VoiceDeriveSpec;` 다음 줄에:

```ts
  loudness?: LoudnessDeriveSpec;   // 2패스 loudnorm. voice 뒤에 붙는다(체인 순서 맨 끝)
```

`VOICE_TRUE_PEAK_DB` 선언 아래에:

```ts
/**
 * 음악용 LRA(허용 음량 폭). **loudnorm 은 원본의 폭이 LRA 보다 넓으면 혼자 「동적 모드」로
 * 바꿔** 곡 안의 여린 데를 올리고 센 데를 눌러 평평하게 만든다. 목소리 프리셋 값(11·7)을
 * 음악에 그대로 주면 그 일이 벌어진다. 20 이면 대부분의 곡이 「상수 게인 1번」(linear)에
 * 머물러 음량만 바뀌고 셈여림은 그대로다.
 */
export const MUSIC_LRA = 20;

/**
 * 어떤 LRA 로 맞출 것인가. **사용자 노브로 열지 않는다** — 틀리게 만지면 곡이 평평해지는데
 * 화면에는 「음량을 맞췄다」고만 보여서 원인을 못 찾는다.
 * voice 체인에는 acompressor 가 들어 있어 이미 폭이 좁혀졌으므로 프리셋 값이 맞고,
 * voice 가 없으면 아무것도 안 좁혔으니 넉넉히 준다.
 */
export function loudnessLra(spec: DeriveSpec): number {
  return spec.voice ? voiceLra(spec.voice.preset) : MUSIC_LRA;
}
```

`packages/media/src/index.ts` 의 re-export(현재 41행 근처, `VoicePresetId` 가 있는 줄)에 `LoudnessDeriveSpec` 를 타입 목록에, `MUSIC_LRA`·`loudnessLra` 를 값 목록에 추가한다.

- [ ] **Step 4: `loudnormMeasure`·`loudnormApply` 의 시그니처를 바꾼다**

두 함수는 지금 `VoiceDeriveSpec` 을 통째로 받아 `voice.targetLufs` 와 `voiceLra(voice.preset)` 을 꺼낸다. 이제 voice 를 몰라야 한다.

```ts
/** 1패스: 체인 «적용 후» 의 라우드니스를 잰다 (컴프·리미터가 라우드니스를 바꾸므로). */
function loudnormMeasure(targetLufs: number, lra: number, statsName: string): string {
  return (
    `loudnorm=I=${num(targetLufs)}:TP=${num(VOICE_TRUE_PEAK_DB)}:LRA=${lra}` +
    `:print_format=json:stats_file=${statsName}`
  );
}

/** 2패스: 1패스가 잰 값을 measured_* 로 넣는다. 출력 stats 도 남겨 normalization_type 을 읽는다. */
function loudnormApply(targetLufs: number, lra: number, m: LoudnormStats, statsName: string): string {
  return (
    `loudnorm=I=${num(targetLufs)}:TP=${num(VOICE_TRUE_PEAK_DB)}:LRA=${lra}` +
    `:measured_I=${m.input_i}:measured_LRA=${m.input_lra}:measured_TP=${m.input_tp}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}` +
    `:print_format=json:stats_file=${statsName}`
  );
}
```

`deriveMedia` 안의 호출부 4곳은 아직 옛 인자를 넘기므로 타입 오류가 난다. **Task 3 에서 고친다** — 이 태스크는 여기서 멈추고, 컴파일은 Task 3 끝에 맞춘다. 그래서 Step 5 는 타입체크가 아니라 단위 테스트만 본다.

- [ ] **Step 5: 새 테스트만 통과하는지 확인한다**

Run: `npm test -w @kitkat/media -- derive-w8 -t "loudnessLra"`
Expected: PASS — `loudnessLra` 2개 통과 (vitest 는 트랜스파일만 하므로 다른 곳의 타입 오류가 이 테스트를 막지 않는다)

- [ ] **Step 6: 커밋**

```bash
git add packages/media/src/derive.ts packages/media/src/index.ts packages/media/test/derive-w8.test.ts
git commit -m "media: loudnorm 함수가 voice 를 모르게 한다 (배선은 다음 커밋)"
```

---

### Task 3: media — `deriveMedia` 배선

**Files:**
- Modify: `packages/media/src/derive.ts:536-760` (`deriveMedia` 본문)
- Test: `packages/media/test/derive-w8.test.ts`

**Interfaces:**
- Consumes: Task 2 의 `loudnessLra`, 새 시그니처의 `loudnormMeasure`/`loudnormApply`, `DeriveSpec.loudness`
- Produces: `deriveMedia` 가 `spec.voice` 없이 `spec.loudness` 만으로도 loudnorm 2패스를 돈다

**게이트 7곳 — 하나라도 빠지면 「설정했는데 아무 일도 안 일어난다」가 된다.** 지금 전부 `voice` 를 보고 있다.

| # | 위치(현재) | 지금 | 바꿀 것 |
|---|---|---|---|
| 1 | 547행 빈 스펙 가드 | `af == null && …` 이면 throw | `&& spec.loudness == null` 추가 |
| 2 | 568행 `needStageB` | `audioOnly \|\| useLut \|\| af != null \|\| …` | `\|\| loudness != null` 추가 |
| 3 | 572행 `passPlan` | `if (voice) push('voice:loudnorm-measure')` | `if (loudness) push('loudnorm:measure')` |
| 4 | 615행 측정 패스 | `if (voice) {…}` | `if (loudness) {…}` |
| 5 | 643행 `audioParts` | `if (voice && measured)` | `if (loudness && measured)` |
| 6 | 650행 `arArgs` | `voice ? ['-ar','48000'] : []` | `loudness ? …` |
| 7 | 680행 `applyAudio` | `af != null && info.hasAudio` | `info.hasAudio && audioParts().length > 0` |

그리고 `filter_complex` 안의 `voice && measured ? [loudnormApply(...)] : []` 세 곳(661·707행과 measure 패스)도 `loudness && measured` 로 바꾸고 새 인자를 넘긴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/media/test/derive-w8.test.ts` 의 `describe('deriveMedia — W8 S3 필드')` 안, `'voice → …'` 테스트 다음에 붙인다.

```ts
  it('loudness 만 (voice 없이) → loudnorm 2패스가 돈다 — 이번에 고치는 핵심', async () => {
    const { r, info } = await check('w6', 'kloud', { loudness: { targetLufs: -20 } });
    const a = (info.streams ?? []).find((s) => s.codec_type === 'audio') as { sample_rate?: string } | undefined;
    // loudnorm 은 트루피크 검출로 192kHz 로 업샘플한다 — 48000 이면 -ar 이 걸렸다는 뜻
    expect(a?.sample_rate).toBe('48000');
    expect(r.loudnorm?.normalization_type).toMatch(/^(linear|dynamic)$/);
  }, T5);

  it('voice 만 (loudness 없이) → 음색만 바뀌고 loudnorm 통계가 «없다»', async () => {
    const r = await deriveMedia(vid, outDir, 'w7', 'kvonly', { voice: { preset: 'warm' } });
    expect(r.src).toBe('derived/w7.kvonly.mp4');
    expect(r.loudnorm).toBeUndefined();
  }, T5);
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -w @kitkat/media -- derive-w8 -t "loudness 만"`
Expected: FAIL — `빈 파생 스펙` 에러로 죽는다 (게이트 #1)

- [ ] **Step 3: 게이트 7곳을 고친다**

`deriveMedia` 본문. `const voice = …` 다음 줄에 형제 변수를 만든다:

```ts
  // voice 는 오디오가 있을 때만 의미가 있다 — 없으면 loudnorm 패스도 돌지 않는다
  const voice = info.hasAudio ? spec.voice : undefined;
  // 음량 맞춤은 voice 와 «독립» 이다. 목소리 프리셋 없이 음악에만 걸 수 있어야 한다.
  const loudness = info.hasAudio ? spec.loudness : undefined;
  const lra = loudnessLra(spec);
```

게이트 #1 (빈 스펙 가드):

```ts
  if (!useLut && !useStab && af == null && pre.length === 0 && post.length === 0 && spec.loudness == null) {
    throw new Error('빈 파생 스펙');
  }
```

게이트 #2 (`needStageB`):

```ts
  const needStageB = audioOnly || useLut || af != null || pre.length > 0 || post.length > 0 || loudness != null;
```

게이트 #3 (`passPlan`):

```ts
  if (loudness) passPlan.push('loudnorm:measure');
```

게이트 #4·측정 패스 전체를 아래로 바꾼다 (리버브는 voice 것이고 측정은 loudness 것이다):

```ts
    // ── 오디오 그래프 조립 (loudnorm 2패스 · 리버브) ──
    const useReverb = voice?.reverb != null;
    let measured: LoudnormStats | undefined;
    if (loudness) {
      // 1패스: «체인 적용 후» 를 잰다. 리버브도 라우드니스를 바꾸므로 리버브 뒤에서 잰다.
      const measureArgs = ['-y', '-i', stageSrc];
      if (useReverb) measureArgs.push('-i', voice!.reverb!.irAbs);
      if (useReverb) {
        measureArgs.push(
          '-filter_complex',
          [
            link('0:a', [...(af ? [af] : []), 'aformat=channel_layouts=stereo'], 'dry', true),
            `[dry][1:a]afir=dry=1:wet=${num(voice!.reverb!.wet)}:irfmt=input:gtype=peak[rv]`,
            link('rv', [loudnormMeasure(loudness.targetLufs, lra, 'ln1.json')], 'aout', true),
          ].join(';'),
          '-map', '[aout]',
        );
      } else {
        measureArgs.push('-vn', '-af',
          [...(af ? [af] : []), loudnormMeasure(loudness.targetLufs, lra, 'ln1.json')].join(','));
      }
      measureArgs.push('-f', 'null', '-');
      await runFfmpegProgress(measureArgs, info.durationMs, passProgress, { cwd: tmp });
      const raw = await readLoudnormStats(path.join(tmp, 'ln1.json'));
      // 거의 무음이면 input_i 가 -inf 로 나온다 → measured_* 에 넣으면 ffmpeg 이 죽는다.
      // 그런 소스는 맞출 라우드니스가 없으므로 2패스를 포기한다.
      measured = loudnormStatsUsable(raw) ? raw : undefined;
      endPass();
    }
```

게이트 #5·#6:

```ts
    /** 2패스 loudnorm 까지 붙인 오디오 필터 목록(체인 순서 그대로). */
    const audioParts = (): string[] => {
      const parts = af ? [af] : [];
      if (loudness && measured) parts.push(loudnormApply(loudness.targetLufs, lra, measured, 'ln2.json'));
      return parts;
    };
    const arArgs = loudness ? ['-ar', '48000'] : [];
```

`audioOnly` 분기의 `filter_complex` 안:

```ts
            link('rv', loudness && measured
              ? [loudnormApply(loudness.targetLufs, lra, measured, 'ln2.json')] : [], 'aout', true),
```

`audioOnly` 분기 끝의 stats 읽기:

```ts
      const stats = loudness ? await readLoudnormStats(path.join(tmp, 'ln2.json')).catch(() => undefined) : undefined;
```

게이트 #7 (stage B):

```ts
      // af 가 없어도 loudnorm 만 붙는 경우가 있다(음악 음량 맞춤) — 목록이 비었는지로 판정한다
      const applyAudio = info.hasAudio && audioParts().length > 0;
```

stage B 의 `filter_complex` 리버브 분기 안:

```ts
              graphs.push(
                link('rv', loudness && measured
                  ? [loudnormApply(loudness.targetLufs, lra, measured, 'ln2.json')] : [], 'aout', true),
              );
```

stage B 뒤의 stats 읽기:

```ts
    const stats = loudness
      ? await readLoudnormStats(path.join(tmp, 'ln2.json')).catch(() => undefined)
      : undefined;
```

- [ ] **Step 4: 타입체크와 테스트를 돌린다**

Run: `npm run build -w @kitkat/media && npm test -w @kitkat/media -- derive-w8`
Expected: PASS — 빌드 성공, 기존 voice 테스트 + 새 loudness 테스트 전부 통과

주의: `'voice → 오디오·비디오 유지 + 48kHz + loudnorm 통계 반환'` 기존 테스트는 `{ voice: { preset:'broadcast', targetLufs:-14 } }` 를 넘긴다. `DeriveSpec.voice` 에는 여전히 `targetLufs` 가 있으므로(media 타입은 안 건드렸다) 컴파일은 되지만 이제 loudnorm 은 안 돈다 → `r.loudnorm` 이 undefined 라 실패한다. **이 테스트를 `{ voice: { preset:'broadcast' }, loudness: { targetLufs:-14 } }` 로 고친다.** 같은 이유로 347행 `describe('2패스 loudnorm')` 안의 세 테스트도 같은 형태로 고친다.

- [ ] **Step 5: 전체 media 테스트를 돌린다**

Run: `npm run build -w @kitkat/media && npm test -w @kitkat/media`
Expected: PASS — 전부 통과

- [ ] **Step 6: 커밋**

```bash
git add packages/media/src/derive.ts packages/media/test/derive-w8.test.ts
git commit -m "media: deriveMedia 가 voice 없이 loudness 만으로 loudnorm 을 돌린다"
```

---

### Task 4: server — `fillSourceSpec` 배선

**Files:**
- Modify: `packages/server/src/routes/commands.ts:133-161`
- Test: 아래 Step 1 참조 (server 테스트가 없으면 만들지 않는다 — Task 6 의 실측이 이 경로를 덮는다)

**Interfaces:**
- Consumes: Task 1 의 `normalizeLoudness`, Task 2 의 `LoudnessDeriveSpec`
- Produces: `spec.loudness` 가 채워진 `DeriveSpec`

- [ ] **Step 1: `fillSourceSpec` 을 고친다**

파일 위쪽 import 에 `normalizeLoudness` 를 추가한다 (`@kitkat/schema` 에서).

현재 143~161행의 voice 블록을 아래로 바꾼다:

```ts
  // 음량 맞춤은 voice 와 «별개» 로 채운다 — 프리셋을 꺼도(off) loudness 가 있으면 맞춘다.
  // 옛 문서의 voice.targetLufs 도 여기서 흡수한다(normalizeLoudness 한 곳에서만 판단).
  const loud = normalizeLoudness(source);
  if (loud) spec.loudness = { targetLufs: loud.targetLufs };

  if (source.voice && source.voice.preset !== 'off') {
    const v = source.voice;
    spec.voice = { preset: v.preset as VoicePresetId };
    if (v.reverb) {
      // IR 은 vendor/ir/ 에 있다 (scripts/prewarm.mjs voice-ir). 없으면 «조용히 건너뛰지 않고»
      // 잡을 실패시킨다 — 리버브를 켰는데 아무 일도 안 일어나는 것이 제일 나쁘다.
      const irAbs = voiceIrPath(v.reverb.irId);
      try {
        await access(irAbs);
      } catch {
        throw new Error(
          `공간감 IR 파일을 찾을 수 없습니다: ${v.reverb.irId} — \`node scripts/prewarm.mjs voice-ir\` 로 내려받으세요`,
        );
      }
      spec.voice.reverb = { irAbs, wet: v.reverb.wet };
    }
  }
```

`DEFAULT_TARGET_LUFS` import 가 이 파일에서 더 이상 안 쓰이면 지운다(`normalizeLoudness` 가 안에서 쓴다).

- [ ] **Step 2: 빌드와 테스트를 돌린다**

Run: `npm run build -w @kitkat/server && npm test -w @kitkat/server`
Expected: PASS — 빌드 성공

- [ ] **Step 3: 커밋**

```bash
git add packages/server/src/routes/commands.ts
git commit -m "server: loudness 를 voice 와 별개로 DeriveSpec 에 채운다"
```

---

### Task 5: UI — 음량 맞춤을 프리셋 밖으로

**Files:**
- Modify: `packages/ui/src/components/sections/SourceSection.tsx:90-190` (`VoiceGroup`)

**Interfaces:**
- Consumes: Task 1 의 `LoudnessSpec`, `normalizeLoudness`
- Produces: 없음 (화면만)

지금 `VoiceGroup` 은 목표 LUFS 드롭다운·슬라이더를 `voice` 안에 쓰고, 프리셋이 `off` 면 `voice` 자체를 `undefined` 로 만들어 버려서 목표 LUFS 를 만질 수 없다. 이걸 두 덩어리로 나눈다.

현재 `VoiceGroup` 의 구조는 이렇다 (실제 코드, 100~185행):

- `SelectField label="나레이션"` — 프리셋. `off` 를 고르면 `voice` 필드를 통째로 지운다
- `{preset !== 'off' ? (…) : null}` 안에 **네 개가 다 들어 있다**: `SelectField label="내보낼 곳"`(LUFS 프리셋) · `SliderField label="목표 크기"`(targetLufs) · IR 드롭다운 · wet 슬라이더 · 측정 표시

앞의 둘은 음량이고 뒤의 셋은 음색이다. 그 경계로 자른다.

- [ ] **Step 1: 변수를 나눈다**

`VoiceGroup` 머리(현재 99~105행)를 아래로 바꾼다:

```ts
  const voice = source.voice;
  const preset: VoicePreset = voice?.preset ?? 'off';
  // 음량 맞춤은 프리셋과 «별개» 노브다 — 프리셋을 꺼도 음악 음량은 맞출 수 있어야 한다.
  const loudnessOn = source.loudness != null;
  const targetLufs = source.loudness?.targetLufs ?? DEFAULT_TARGET_LUFS;
  // 지금 값이 어느 프리셋인지. 프리셋에 없으면 undefined → 「직접 지정」으로 뜬다.
  const loudnessMatch = loudnessTargetOf(targetLufs);
  const measured = useVoiceMeasurement(clip);
  const dynamic = measured?.normalization_type === 'dynamic';
```

- [ ] **Step 2: 「내보낼 곳」·「목표 크기」·측정 표시를 프리셋 밖으로 꺼낸다**

`{preset !== 'off' ? (` 블록에서 `SelectField label="내보낼 곳"` · `SliderField label="목표 크기"` · 맨 아래 측정 표시(`measured` 를 쓰는 부분, 현재 183~190행)를 잘라내고, IR 드롭다운·wet 슬라이더만 그 블록에 남긴다.

잘라낸 것들을 `{preset !== 'off' ? (…) : null}` **뒤에** 새 덩어리로 붙이고, `voice` 대신 `loudness` 를 쓰게 고친다. `CheckField` 는 이 파일이 이미 import 하고 있다(`./fields.js`, 시그니처는 `{ label: string; checked: boolean; onCommit: (v: boolean) => void }`).

```tsx
      <CheckField
        label="음량 맞춤"
        checked={loudnessOn}
        onCommit={(on) =>
          // 끌 때는 필드째 지운다 — 그래야 sourceKey 가 깨끗해지고 필요 없는 파생이 안 생긴다
          setSource({ ...source, loudness: on ? { targetLufs: DEFAULT_TARGET_LUFS } : undefined })
        }
      />
      {loudnessOn ? (
        <>
          <SelectField
            label="내보낼 곳"
            value={loudnessMatch?.id ?? CUSTOM_LUFS}
            options={LUFS_OPTIONS}
            onCommit={(v) => {
              const t = LOUDNESS_TARGETS.find((x) => x.id === v);
              if (!t) return; // «직접 지정» 은 슬라이더로만 바꾼다
              setSource({ ...source, loudness: { targetLufs: t.lufs } });
            }}
          />
          <SliderField
            label="목표 크기"
            value={targetLufs}
            /* min·max·step 등 나머지 props 는 지금 있는 것을 그대로 옮긴다 */
            onCommit={(v) => setSource({ ...source, loudness: { targetLufs: v } })}
          />
          {/* 측정 표시(현재 183~190행)를 여기로 그대로 옮긴다 — measured·dynamic 을 쓰는 부분 */}
        </>
      ) : null}
```

- [ ] **Step 3: 프리셋 라벨을 정직하게 고친다**

`VOICE_PRESET_LABELS.off` 는 지금 `'없음'` 이다. 프리셋을 껐다고 음량까지 꺼지는 것이 아니게 됐으므로 그대로 두면 된다. 대신 `SelectField label="나레이션"` 을 **`label="목소리 다듬기"`** 로 바꾼다 — 「나레이션」은 이제 그 옆 「음량 맞춤」과 구별이 안 된다.

파일 맨 위 주석(3행)도 고친다:

```ts
// + W8 F11: 목소리 다듬기(프리셋·공간감) + 음량 맞춤(목표 LUFS) — 서로 «별개» 노브다.
```

- [ ] **Step 4: 빌드와 테스트를 돌린다**

Run: `npm run build -w @kitkat/ui && npm test -w @kitkat/ui`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/ui/src/components/sections/SourceSection.tsx
git commit -m "UI: 음량 맞춤을 목소리 프리셋에서 분리한다"
```

---

### Task 6: 실측 — 음악에 걸어도 음색이 안 변하는지

**Files:**
- Modify: `packages/media/test/derive-w8.test.ts`

**Interfaces:**
- Consumes: Task 3 의 `deriveMedia` (loudness 경로)
- Produces: 없음 (회귀 테스트)

이 태스크가 이번 작업의 «증거» 다. 「돌아간다」가 아니라 **저음·고음 대역이 같은 양만큼 움직였는가** 를 숫자로 낸다. 상수 게인 하나만 걸렸다면 두 대역이 똑같이 움직인다.

- [ ] **Step 1: 음악 비슷한 테스트 소스와 대역 측정 헬퍼를 만든다**

`packages/media/test/derive-w8.test.ts` 상단 변수 선언부에 추가:

```ts
let music: string;     // 4초 스테레오 — 저음·고음이 둘 다 있는 「음악 비슷한」 신호
```

`beforeAll` 안, `quietTone` 을 만드는 곳 근처에 추가:

```ts
  music = path.join(srcDir, 'm.wav');
  // 핑크 노이즈는 저음·고음이 둘 다 있다. 트레몰로로 셈여림을 줘야 loudnorm 이
  // LRA 0 으로 떨어져 무조건 dynamic 이 되는 것을 피한다.
  await execa('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=4:amplitude=0.3:seed=11',
    '-af', 'tremolo=f=0.25:d=0.6,volume=-6dB',
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', music,
  ]);
```

파일의 헬퍼들 옆(예: `loudness()` 함수 아래)에 추가:

```ts
/** 한 대역만 남기고 평균 레벨(dB)을 잰다. 음색이 변했는지 보려면 대역별로 봐야 한다. */
async function bandDb(file: string, filter: string): Promise<number> {
  const { stderr } = await execa(
    'ffmpeg',
    ['-hide_banner', '-i', file, '-af', `${filter},volumedetect`, '-f', 'null', '-'],
    { reject: false },
  );
  const m = /mean_volume: ([-\d.]+) dB/.exec(stderr);
  if (!m) throw new Error(`volumedetect 를 못 읽었다: ${stderr.slice(-400)}`);
  return Number(m[1]);
}
```

- [ ] **Step 2: 실패하는(=아직 안 쓴) 테스트를 쓴다**

파일 아래쪽에 새 describe 를 붙인다:

```ts
describe('음악 음량 맞춤 — 음량은 맞추고 음색은 안 건드린다 (2026-09-04 실측 근거)', () => {
  const LOW = 'lowpass=f=200';
  const HIGH = 'highpass=f=6000';

  it('loudness 만 걸면 저음·고음이 «같은 양» 움직인다 = 상수 게인 하나', async () => {
    const before = { low: await bandDb(music, LOW), high: await bandDb(music, HIGH) };
    const r = await deriveMedia(music, outDir, 'mus1', 'kmusloud', { loudness: { targetLufs: -24 } },
      { audioOnly: true });
    const out = path.join(outDir, r.src);
    const after = { low: await bandDb(out, LOW), high: await bandDb(out, HIGH) };

    const dLow = after.low - before.low;
    const dHigh = after.high - before.high;
    // 상수 게인이면 두 대역이 똑같이 움직인다. 0.8dB 는 aac 인코딩 오차 여유다.
    expect(Math.abs(dLow - dHigh)).toBeLessThan(0.8);

    // 그리고 실제로 목표에 앉았는지 — 「안 건드렸다」가 아니라 「맞췄다」여야 한다
    const l = await loudness(out);
    expect(Math.abs(l.lufs - (-24))).toBeLessThan(1.0);
  }, T5);

  it('voice 프리셋을 음악에 걸면 저음이 «깎인다» — 이래서 분리했다', async () => {
    const before = { low: await bandDb(music, LOW), high: await bandDb(music, HIGH) };
    const r = await deriveMedia(music, outDir, 'mus2', 'kmusvoice',
      { voice: { preset: 'broadcast' }, loudness: { targetLufs: -24 } }, { audioOnly: true });
    const out = path.join(outDir, r.src);
    const after = { low: await bandDb(out, LOW), high: await bandDb(out, HIGH) };

    // 목소리 체인은 80Hz 아래를 자르고 200·400Hz 를 깎고 3.5k·10k 를 올린다.
    // 두 대역의 움직임이 «다르다» = 음색이 변했다. 이 테스트가 실패하면 voiceChain 이 바뀐 것이다.
    expect((after.low - before.low) - (after.high - before.high)).toBeLessThan(-3);
  }, T5);

  it("voice.preset:'off' 상당(voice 없음) + loudness 없음 = 아무 일도 안 일어난다", async () => {
    await expect(deriveMedia(music, outDir, 'mus3', 'knone', {}, { audioOnly: true }))
      .rejects.toThrow('빈 파생 스펙');
  }, T);
});
```

- [ ] **Step 3: 돌려서 숫자를 본다**

Run: `npm test -w @kitkat/media -- derive-w8 -t "음악 음량 맞춤"`
Expected: PASS 3개.

실패하면 **문턱값을 느슨하게 만들지 말고 원인을 찾는다.** 특히 첫 테스트가 `Math.abs(dLow - dHigh) >= 0.8` 로 실패하면 `r.loudnorm?.normalization_type` 을 찍어 본다 — `"dynamic"` 이면 `MUSIC_LRA` 가 아직 부족한 것이고, 그건 문턱값 문제가 아니라 `MUSIC_LRA` 를 올려야 하는 실제 발견이다. 값과 근거를 이 계획서에 적고 올린다.

- [ ] **Step 4: 전체 테스트를 돌린다**

Run: `npm test`
Expected: PASS — 전 패키지 통과

- [ ] **Step 5: 커밋**

```bash
git add packages/media/test/derive-w8.test.ts
git commit -m "테스트: 음악에 음량만 맞추면 저음·고음이 같은 양 움직인다 (실측)"
```

---

## 끝난 뒤 확인할 것

1. `npm run build && npm test` 가 루트에서 전부 통과한다.
2. 실제 UI 에서 오디오 클립 하나를 골라 프리셋을 「끔」에 두고 「음량 맞춤」만 켜서 −24 를 준다 → 굽고 나서 화면의 측정값이 `−18.5 → −24.0 LUFS` 처럼 나온다.
3. 옛 프로젝트 파일(`voice.targetLufs` 를 쓰던 것)을 열어 아무것도 안 만졌을 때 클립이 다시 구워지지 않는다.

## 남기는 티켓

- **트루피크가 목표별로 다르다.** `LOUDNESS_TARGETS.google-ads` 는 `truePeakDb: -2` 인데 `derive.ts` 는 `VOICE_TRUE_PEAK_DB = -1.0` 을 하드코딩한다. 광고 납품 규격을 골라도 트루피크는 −1 로 나간다. 별도로 고친다.

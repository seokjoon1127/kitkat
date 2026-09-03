import {
  ProjectDocSchema,
  TEXT_TEMPLATES,
  easingFn,
  isKeyframablePath,
  keyframePathRejection,
  rampDurationMs,
  readPath,
  validateDoc,
  findUnknownKeys,
  describeUnknownKeys,
  newId,
  type Asset,
  type Clip,
  type Keyframe,
  type ProjectDoc,
  type SpeedPoint,
  type Track,
  type VideoClip,
  type WordTiming,
} from '@kitkat/schema';
import { duckKeyframes, type DuckCurve, type DuckInterval } from './duck.js';

// ── C2. 편집 명령 (23종 — v1 19종 + W5 4종) ───────────────────────────────

export type Command =
  | { type: 'renameProject'; name: string }
  | { type: 'setSettings'; settings: Partial<ProjectDoc['settings']> }
  | { type: 'addAsset'; asset: Asset }
  | { type: 'removeAsset'; assetId: string }              // 참조 클립 있으면 EngineError
  | { type: 'updateAsset'; assetId: string; patch: Partial<Asset> }
  | { type: 'addTrack'; track: { id: string; kind: Track['kind']; name: string }; index?: number }
  | { type: 'removeTrack'; trackId: string }
  | { type: 'reorderTrack'; trackId: string; index: number }
  | { type: 'setTrackProps'; trackId: string; patch: { name?: string; volume?: number; muted?: boolean; locked?: boolean; hidden?: boolean } }
  | { type: 'addClip'; trackId: string; clip: Clip }      // 겹침·트랙 kind 불일치 시 EngineError
  | { type: 'removeClip'; clipId: string }
  | { type: 'moveClip'; clipId: string; start: number; trackId?: string }
  | { type: 'splitClip'; clipId: string; at: number; newClipId?: string }
  //  ^ at = 타임라인 절대 ms. newClipId = 오른쪽 조각 id — 낙관 적용/브로드캐스트 재적용이 결정적이도록
  //    명령 생성 시점에 지정한다(서버는 미지정 시 채워서 브로드캐스트)
  | { type: 'trimClip'; clipId: string; edge: 'start' | 'end'; to: number }
  | { type: 'setClipSpeed'; clipId: string; speed: number }   // video/audio 전용
  | { type: 'setReversed'; clipId: string; reversed: boolean }
  | { type: 'updateClip'; clipId: string; patch: Record<string, unknown> }
  | { type: 'setKeyframes'; clipId: string; keyframes: Keyframe[] }
  | { type: 'restoreDoc'; doc: ProjectDoc }               // undo용 전체 교체
  // ── W5 (X2) ──
  | { type: 'freezeFrame'; clipId: string; at: number; duration: number; newClipIds?: [string, string] }
  //  ^ newClipIds = [정지클립 id, 오른쪽 조각 id] — splitClip과 같은 결정성 규칙(미지정 시 서버가 채운다)
  | { type: 'setSpeedRamp'; clipId: string; points: SpeedPoint[] | null }   // null = 램프 해제
  | { type: 'duckTrack'; musicTrackId: string; voiceTrackId: string;
      amount: number; attackMs: number; releaseMs: number;
      // ── W8 F12 (전부 optional — 기존 인자만으로도 전과 똑같이 동작한다) ──
      /** 파형 포락선으로 뽑은 목소리 구간(타임라인 절대 ms). 없으면 「목소리 클립이 놓인 구간 전부」. */
      intervals?: DuckInterval[];
      /** 램프 이징. 'comp' 는 컴프의 지수 곡선에 가까운 베지어. 미지정이면 'linear'. */
      curve?: DuckCurve;
      /** true 면 렌더에서 «진짜» 사이드체인 컴프를 쓰도록 Track.duckedBy·duck 을 같이 설정한다. */
      sidechain?: boolean }
  | { type: 'applyTextTemplate'; clipId: string; templateId: string };

export class EngineError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'EngineError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new EngineError(code, message);
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────────

/** 트랙 kind별 허용 클립 kind */
export const TRACK_ACCEPTS: Record<Track['kind'], readonly Clip['kind'][]> = {
  video: ['video', 'image'],
  overlay: ['video', 'image', 'text'],
  text: ['text'],
  audio: ['audio'],
};

/**
 * @deprecated W8 S1 이후 «검증에 쓰지 않는다». 허용 경로는 `KEYFRAME_PATHS`(schema)이고
 * 검사는 `isKeyframablePath` 가 한다. 기존 UI 가 import 하고 있어 하위호환으로만 남긴다.
 */
export const KEYFRAME_PROPS: Record<Clip['kind'], readonly string[]> = {
  video: ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'],
  audio: ['volume'],
  image: ['x', 'y', 'scale', 'rotation', 'opacity'],
  text: ['x', 'y', 'scale', 'rotation', 'opacity'],
};

export function findClip(doc: ProjectDoc, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of doc.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  return null;
}

function mustFindClip(doc: ProjectDoc, clipId: string): { track: Track; clip: Clip; index: number } {
  const found = findClip(doc, clipId);
  if (!found) fail('CLIP_NOT_FOUND', `클립을 찾을 수 없습니다: ${clipId}`);
  return found;
}

function mustFindTrack(doc: ProjectDoc, trackId: string): Track {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) fail('TRACK_NOT_FOUND', `트랙을 찾을 수 없습니다: ${trackId}`);
  return track;
}

function assertTrackAccepts(track: Track, clipKind: Clip['kind']): void {
  if (!TRACK_ACCEPTS[track.kind].includes(clipKind)) {
    fail('TRACK_KIND_MISMATCH', `${track.kind} 트랙에는 ${clipKind} 클립을 놓을 수 없습니다`);
  }
}

/** 트랙 클립을 start 오름차순 정렬 후 겹침 검사 (겹치면 throw) */
function sortAndCheckOverlap(track: Track): void {
  track.clips.sort((a, b) => a.start - b.start);
  for (let i = 1; i < track.clips.length; i++) {
    const prev = track.clips[i - 1]!;
    const cur = track.clips[i]!;
    if (cur.start < prev.start + prev.duration) {
      fail('OVERLAP', `트랙 "${track.name}"에서 클립 ${prev.id}와 ${cur.id}가 겹칩니다`);
    }
  }
}

export function assetPathFields(a: Partial<Asset>): (string | undefined)[] {
  const paths: (string | undefined)[] = [a.src, a.proxySrc, a.waveformSrc, a.thumbSrc, a.reversedSrc];
  for (const derived of Object.values(a.derived ?? {})) {
    paths.push(derived?.src, derived?.proxySrc);   // 파생 파일 경로도 forward slash 전용 (W5)
  }
  return paths;
}

/**
 * video/audio 클립의 duration 불변식 검사 — 위반이면 설명 문자열, 정상이면 null.
 * freeze/loop 는 검사 제외, speedRamp 는 `|duration - rampDurationMs| <= 2`,
 * 그 외는 `duration === (out-in)/speed` (±1ms). (계획 X1 — schema·doAddClip·checkInvariants 공통 규칙)
 */
export function durationProblem(clip: Extract<Clip, { in: number }>): string | null {
  if (clip.kind === 'video') {
    if (clip.freeze === true || clip.loop === true) return null;
    if (clip.speedRamp) {
      const expected = rampDurationMs(clip);
      return Math.abs(clip.duration - expected) > 2
        ? `duration(${clip.duration})이 rampDurationMs(${expected})와 2ms 넘게 다릅니다`
        : null;
    }
  }
  const expected = (clip.out - clip.in) / clip.speed;
  return Math.abs(clip.duration - expected) > 1
    ? `duration(${clip.duration})이 (out-in)/speed(${expected.toFixed(1)})와 1ms 넘게 다릅니다`
    : null;
}

function assertNoBackslash(a: Partial<Asset>): void {
  for (const p of assetPathFields(a)) {
    if (p != null && p.includes('\\')) fail('BAD_PATH', `경로에 백슬래시를 쓸 수 없습니다: ${p}`);
  }
}

function assertValidDoc(doc: ProjectDoc, code: string): void {
  const r = ProjectDocSchema.safeParse(doc);
  if (!r.success) {
    const first = r.error.issues[0];
    fail(code, `문서 유효성 위반: ${first ? `${first.path.join('.')} — ${first.message}` : r.error.message}`);
  }
  // Zod 는 모르는 키를 «조용히 벗겨 내고» 통과시킨다. 그러면 오타·없는 기능이 200 으로 저장돼
  // 아무 일도 안 일어난다 (실제로 이미지 클립의 chromaKey 가 그랬다 — W8 F17 리뷰 #1).
  // 원본과 벗겨 낸 결과를 나란히 걸어 원본에만 있는 키를 거절한다.
  const unknown = findUnknownKeys(doc, r.data);
  if (unknown.length > 0) {
    fail('UNKNOWN_FIELD', describeUnknownKeys(unknown) + ' — 이 자리에는 그런 필드가 없습니다. 오타이거나, 이 클립 종류가 지원하지 않는 설정입니다.');
  }
}

// ── 키프레임 보간·재기준 (렌더러 interpolateKeyframes와 동일 의미론) ──────
// 이징 구현은 @kitkat/schema 의 easingFn «한 벌»뿐이다 (W8 S2). 여기에 사본을 다시
// 만들지 마라 — 두 벌이 되는 순간 미리보기와 렌더가 갈린다.

/** 같은 prop의 time 오름차순 키프레임 목록에서 t 시점 보간값 */
function interpolatePropAt(sorted: Keyframe[], t: number): number {
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (t <= first.time) return first.value;
  if (t >= last.time) return last.value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i]!;
    const to = sorted[i + 1]!;
    if (t >= from.time && t <= to.time) {
      if (to.time === from.time) return to.value;
      const u = (t - from.time) / (to.time - from.time);
      return from.value + (to.value - from.value) * easingFn(from.easing)(u);
    }
  }
  return last.value;
}

/**
 * 키프레임을 분할 지점 기준으로 좌/우 분배 (우측은 0 기준으로 재조정).
 * 분할점에 키프레임이 없는 prop은 분할점의 보간값을 경계 키프레임으로 양쪽에 삽입해,
 * 진행 중이던 애니메이션(램프)이 분할 후 상수/점프로 변하지 않게 한다.
 */
function splitKeyframes(kfs: Keyframe[] | undefined, leftDur: number): { left?: Keyframe[]; right?: Keyframe[] } {
  if (!kfs || kfs.length === 0) return { left: kfs, right: kfs };
  const left: Keyframe[] = kfs.filter((k) => k.time <= leftDur).map((k) => ({ ...k }));
  const right: Keyframe[] = kfs.filter((k) => k.time >= leftDur).map((k) => ({ ...k, time: k.time - leftDur }));
  for (const prop of new Set(kfs.map((k) => k.prop))) {
    const sorted = kfs.filter((k) => k.prop === prop).sort((x, y) => x.time - y.time);
    if (sorted.some((k) => k.time === leftDur)) continue; // 경계에 이미 키프레임이 있음
    const value = interpolatePropAt(sorted, leftDur);
    const prev = [...sorted].reverse().find((k) => k.time < leftDur);
    const easing = prev?.easing ?? sorted[0]!.easing;
    left.push({ time: leftDur, prop, value, easing });
    right.push({ time: 0, prop, value, easing });
  }
  left.sort((x, y) => x.time - y.time);
  right.sort((x, y) => x.time - y.time);
  return { left: left.length ? left : undefined, right: right.length ? right : undefined };
}

/**
 * 클립 시작이 delta(ms)만큼 뒤로 이동할 때(start 트림) 키프레임을 새 시작점 기준으로 재기준한다.
 * delta > 0: 분할의 오른쪽 절반과 동일 규칙(경계 보간값 삽입 + 지난 키프레임 제거).
 * delta < 0: 전체를 |delta|만큼 뒤로 민다.
 */
function rebaseKeyframes(kfs: Keyframe[] | undefined, delta: number): Keyframe[] | undefined {
  if (!kfs || kfs.length === 0 || delta === 0) return kfs;
  if (delta < 0) return kfs.map((k) => ({ ...k, time: k.time - delta }));
  return splitKeyframes(kfs, delta).right;
}

/** words(클립 상대 ms)를 start 트림 delta만큼 재기준한다 (splitClip의 오른쪽 절반과 동일 규칙). */
function rebaseWords(words: WordTiming[] | undefined, delta: number): WordTiming[] | undefined {
  if (!words || words.length === 0 || delta === 0) return words;
  if (delta < 0) return words.map((w) => ({ ...w, start: w.start - delta }));
  const kept = words.filter((w) => w.start >= delta).map((w) => ({ ...w, start: w.start - delta }));
  return kept.length ? kept : undefined;
}

// ── 명령별 적용 (doc은 이미 복제된 것 — 자유롭게 변형) ────────────────────

function doAddAsset(d: ProjectDoc, asset: Asset): void {
  if (d.assets[asset.id]) fail('DUPLICATE_ID', `이미 존재하는 에셋 id: ${asset.id}`);
  assertNoBackslash(asset);
  d.assets[asset.id] = structuredClone(asset);
}

function doRemoveAsset(d: ProjectDoc, assetId: string): void {
  if (!d.assets[assetId]) fail('ASSET_NOT_FOUND', `에셋을 찾을 수 없습니다: ${assetId}`);
  for (const track of d.tracks) {
    for (const clip of track.clips) {
      if ('assetId' in clip && clip.assetId === assetId) {
        fail('ASSET_IN_USE', `에셋 ${assetId}을(를) 참조하는 클립(${clip.id})이 있어 삭제할 수 없습니다`);
      }
      // LUT 은 clip.assetId 가 아니라 clip.source.lut.assetId 로 참조된다 (W5 M2).
      // 여기서 안 막으면 쓰고 있는 .cube 가 경고 없이 사라지고, 그 뒤 derive 잡이 매번 실패한다.
      const lutId = (clip as { source?: { lut?: { assetId: string } } }).source?.lut?.assetId;
      if (lutId === assetId) {
        fail('ASSET_IN_USE', `에셋 ${assetId}을(를) LUT으로 쓰는 클립(${clip.id})이 있어 삭제할 수 없습니다`);
      }
    }
  }
  const bg = d.settings.background;
  if (bg.kind === 'image' && bg.assetId === assetId) {
    fail('ASSET_IN_USE', `에셋 ${assetId}이(가) 배경으로 사용 중이라 삭제할 수 없습니다`);
  }
  delete d.assets[assetId];
}

function doUpdateAsset(d: ProjectDoc, assetId: string, patch: Partial<Asset>): void {
  const asset = d.assets[assetId];
  if (!asset) fail('ASSET_NOT_FOUND', `에셋을 찾을 수 없습니다: ${assetId}`);
  if (patch.id !== undefined && patch.id !== assetId) fail('BAD_PATCH', '에셋 id는 변경할 수 없습니다');
  assertNoBackslash(patch);
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id') continue;
    if (v === undefined || v === null) delete (asset as Record<string, unknown>)[k];
    else (asset as Record<string, unknown>)[k] = structuredClone(v);
  }
}

function doAddClip(d: ProjectDoc, trackId: string, clip: Clip): void {
  const track = mustFindTrack(d, trackId);
  assertTrackAccepts(track, clip.kind);
  if (findClip(d, clip.id)) fail('DUPLICATE_ID', `이미 존재하는 클립 id: ${clip.id}`);
  if ('assetId' in clip && !d.assets[clip.assetId]) {
    fail('ASSET_NOT_FOUND', `클립이 참조하는 에셋이 없습니다: ${clip.assetId}`);
  }
  if (clip.start < 0 || clip.duration <= 0) fail('BAD_CLIP', 'start는 0 이상, duration은 양수여야 합니다');
  if (clip.kind === 'video' || clip.kind === 'audio') {
    if (clip.out <= clip.in) fail('BAD_CLIP', `out(${clip.out})은 in(${clip.in})보다 커야 합니다`);
    const problem = durationProblem(clip);
    if (problem) fail('BAD_CLIP', problem);
  }
  track.clips.push(structuredClone(clip));
  sortAndCheckOverlap(track);
}

function doMoveClip(d: ProjectDoc, clipId: string, start: number, trackId?: string): void {
  if (!Number.isInteger(start)) fail('BAD_MOVE', `start는 정수 ms여야 합니다 (받은 값: ${start})`);
  if (start < 0) fail('BAD_MOVE', 'start는 0 이상이어야 합니다');
  const { track, clip, index } = mustFindClip(d, clipId);
  let target = track;
  if (trackId !== undefined && trackId !== track.id) {
    target = mustFindTrack(d, trackId);
    assertTrackAccepts(target, clip.kind);
    track.clips.splice(index, 1);
    target.clips.push(clip);
  }
  clip.start = start;
  sortAndCheckOverlap(target);
}

function doSplitClip(d: ProjectDoc, clipId: string, at: number, newClipId?: string): void {
  const { track, clip, index } = mustFindClip(d, clipId);
  // 소스 분할점을 leftDur*speed 로 계산하는 전제가 램프에서는 성립하지 않는다 (X2)
  if (clip.kind === 'video' && clip.speedRamp) {
    fail('BAD_RAMP', '속도 커브가 걸린 클립은 나눌 수 없습니다. 먼저 속도 커브를 해제하세요(setSpeedRamp points:null).');
  }
  if (!Number.isInteger(at)) fail('BAD_SPLIT', `분할 지점은 정수 ms여야 합니다 (받은 값: ${at})`);
  const end = clip.start + clip.duration;
  if (at <= clip.start || at >= end) {
    fail('BAD_SPLIT', `분할 지점(${at})은 클립 내부(${clip.start}..${end})여야 합니다`);
  }
  // 오른쪽 조각 id — 명령이 지정한 id를 그대로 써서 서버·모든 클라이언트에서 결정적이 되게 한다
  const rightId = newClipId ?? newId();
  if (findClip(d, rightId)) fail('DUPLICATE_ID', `이미 존재하는 클립 id: ${rightId}`);
  const leftDur = at - clip.start;
  const rightDur = end - at;

  let left: Clip;
  let right: Clip;
  const kf = splitKeyframes(clip.keyframes, leftDur);
  if (clip.kind === 'video' || clip.kind === 'audio') {
    // reversed video는 타임라인 t=0 ↔ 소스 out 이므로 분할점을 소스 반대 끝에서 계산한다
    const mirrored = clip.kind === 'video' && clip.reversed === true;
    const srcSpan = Math.round(leftDur * clip.speed);
    const srcSplit = mirrored ? clip.out - srcSpan : clip.in + srcSpan;
    if (srcSplit <= clip.in || srcSplit >= clip.out) {
      fail('BAD_SPLIT', '분할 결과 소스 구간이 비게 됩니다 (분할 지점이 너무 가장자리에 있습니다)');
    }
    const l = mirrored
      ? { ...clip, duration: leftDur, in: srcSplit, keyframes: kf.left }
      : { ...clip, duration: leftDur, out: srcSplit, keyframes: kf.left };
    const r = mirrored
      ? { ...clip, id: rightId, start: at, duration: rightDur, out: srcSplit, keyframes: kf.right }
      : { ...clip, id: rightId, start: at, duration: rightDur, in: srcSplit, keyframes: kf.right };
    // 오디오 페이드·전환은 바깥쪽 가장자리에만 남긴다
    delete l.fadeOut;
    delete r.fadeIn;
    if (l.kind === 'video') delete l.transitionOut;
    if (r.kind === 'video') delete r.transitionIn;
    left = l;
    right = r;
  } else {
    const l = { ...clip, duration: leftDur, keyframes: kf.left };
    const r = { ...clip, id: rightId, start: at, duration: rightDur, keyframes: kf.right };
    delete l.transitionOut;
    delete r.transitionIn;
    // 텍스트 등장/퇴장 애니메이션도 안쪽 가장자리에서는 제거한다 (transition과 동일 규칙)
    if (l.kind === 'text') delete l.animationOut;
    if (r.kind === 'text') delete r.animationIn;
    if (l.kind === 'text' && clip.kind === 'text' && clip.words) {
      l.words = clip.words.filter((w) => w.start < leftDur);
    }
    if (r.kind === 'text' && clip.kind === 'text' && clip.words) {
      r.words = clip.words.filter((w) => w.start >= leftDur).map((w) => ({ ...w, start: w.start - leftDur }));
    }
    left = l;
    right = r;
  }
  track.clips.splice(index, 1, left, right);
  sortAndCheckOverlap(track);
}

function doTrimClip(d: ProjectDoc, clipId: string, edge: 'start' | 'end', to: number): void {
  const { track, clip } = mustFindClip(d, clipId);
  // 소스 구간을 newDur*speed 로 계산하는 전제가 램프에서는 성립하지 않는다 (X2)
  if (clip.kind === 'video' && clip.speedRamp) {
    fail('BAD_RAMP', '속도 커브가 걸린 클립은 트림할 수 없습니다. 먼저 속도 커브를 해제하세요(setSpeedRamp points:null).');
  }
  if (!Number.isInteger(to)) fail('BAD_TRIM', `트림 지점은 정수 ms여야 합니다 (받은 값: ${to})`);
  const end = clip.start + clip.duration;

  // freeze/loop video 는 duration 이 소스 구간과 무관하다 → text/image 와 같은 분기로 처리한다 (X2)
  const detached = clip.kind === 'video' && (clip.freeze === true || clip.loop === true);

  if ((clip.kind === 'video' || clip.kind === 'audio') && !detached) {
    // reversed video는 타임라인 t=0 ↔ 소스 out 이므로 소스 구간을 반대 끝에서 조정한다
    const mirrored = clip.kind === 'video' && clip.reversed === true;
    if (edge === 'start') {
      if (to < 0) fail('BAD_TRIM', 'start는 0 이상이어야 합니다');
      const newDur = end - to;
      if (newDur <= 0) fail('BAD_TRIM', '트림 결과 duration이 0 이하입니다');
      const delta = to - clip.start;
      const srcDelta = Math.round(delta * clip.speed);
      if (mirrored) {
        const newOut = clip.out - srcDelta;
        if (newOut <= clip.in) fail('SOURCE_RANGE', `트림 결과 소스 구간(out=${newOut})이 비게 됩니다`);
        const asset = d.assets[clip.assetId];
        if (asset?.duration != null && newOut > asset.duration) {
          fail('SOURCE_RANGE', `트림 결과 out(${newOut})이 소스 길이(${asset.duration})를 초과합니다`);
        }
        clip.out = newOut;
      } else {
        const newIn = clip.in + srcDelta;
        if (newIn < 0 || newIn >= clip.out) {
          fail('SOURCE_RANGE', `트림 결과 소스 구간(in=${newIn})이 범위를 벗어납니다`);
        }
        clip.in = newIn;
      }
      // 클립 기준 상대 시각(keyframes)을 새 시작점으로 재기준
      const kfs = rebaseKeyframes(clip.keyframes, delta);
      if (kfs) clip.keyframes = kfs;
      else delete clip.keyframes;
      clip.start = to;
      clip.duration = newDur;
    } else {
      const newDur = to - clip.start;
      if (newDur <= 0) fail('BAD_TRIM', '트림 결과 duration이 0 이하입니다');
      const srcSpan = Math.round(newDur * clip.speed);
      if (mirrored) {
        const newIn = clip.out - srcSpan;
        if (newIn >= clip.out) fail('BAD_TRIM', '트림 결과 소스 구간이 비게 됩니다');
        if (newIn < 0) fail('SOURCE_RANGE', `트림 결과 in(${newIn})이 소스 범위를 벗어납니다`);
        clip.in = newIn;
      } else {
        const newOut = clip.in + srcSpan;
        if (newOut <= clip.in) fail('BAD_TRIM', '트림 결과 소스 구간이 비게 됩니다');
        const asset = d.assets[clip.assetId];
        if (asset?.duration != null && newOut > asset.duration) {
          fail('SOURCE_RANGE', `트림 결과 out(${newOut})이 소스 길이(${asset.duration})를 초과합니다`);
        }
        clip.out = newOut;
      }
      clip.duration = newDur;
    }
  } else {
    // text/image + freeze/loop video: start/duration만 조정 (소스 구간은 건드리지 않는다)
    if (edge === 'start') {
      if (to < 0) fail('BAD_TRIM', 'start는 0 이상이어야 합니다');
      const newDur = end - to;
      if (newDur <= 0) fail('BAD_TRIM', '트림 결과 duration이 0 이하입니다');
      const delta = to - clip.start;
      // 클립 기준 상대 시각(keyframes·words)을 새 시작점으로 재기준
      const kfs = rebaseKeyframes(clip.keyframes, delta);
      if (kfs) clip.keyframes = kfs;
      else delete clip.keyframes;
      if (clip.kind === 'text') {
        const words = rebaseWords(clip.words, delta);
        if (words) clip.words = words;
        else delete clip.words;
      }
      clip.start = to;
      clip.duration = newDur;
    } else {
      const newDur = to - clip.start;
      if (newDur <= 0) fail('BAD_TRIM', '트림 결과 duration이 0 이하입니다');
      clip.duration = newDur;
    }
  }
  sortAndCheckOverlap(track);
}

function doSetClipSpeed(d: ProjectDoc, clipId: string, speed: number): void {
  const { track, clip } = mustFindClip(d, clipId);
  if (clip.kind !== 'video' && clip.kind !== 'audio') {
    fail('BAD_COMMAND', 'setClipSpeed는 video/audio 클립에만 쓸 수 있습니다');
  }
  // duration을 (out-in)/speed 로 계산하는 전제가 램프에서는 성립하지 않는다 (X2).
  // 막지 않으면 speed와 speedRamp가 동시에 남아 렌더러(램프만 본다)와 UI 배속 표시가 어긋난다.
  if (clip.kind === 'video' && clip.speedRamp) {
    fail('BAD_RAMP', '속도 커브가 걸린 클립은 배속을 바꿀 수 없습니다. 먼저 속도 커브를 해제하세요(setSpeedRamp points:null).');
  }
  if (!Number.isFinite(speed) || speed < 0.1 || speed > 100) {
    fail('BAD_SPEED', `speed는 0.1..100 범위여야 합니다 (받은 값: ${speed})`);
  }
  const newDur = Math.round((clip.out - clip.in) / speed);
  if (newDur <= 0) fail('BAD_SPEED', '속도 적용 결과 duration이 0이 됩니다');
  clip.speed = speed;
  clip.duration = newDur;
  sortAndCheckOverlap(track);
}

function doSetReversed(d: ProjectDoc, clipId: string, reversed: boolean): void {
  const { clip } = mustFindClip(d, clipId);
  if (clip.kind !== 'video') fail('BAD_COMMAND', 'setReversed는 video 클립에만 쓸 수 있습니다');
  if (reversed) clip.reversed = true;
  else delete clip.reversed;
}

// reversed는 setReversed 경로로만 — 서버의 역재생 파일 생성 훅이 setReversed 명령만 감시한다.
// freeze·loop·speedRamp는 duration과 연동되므로 freezeFrame/setSpeedRamp/addClip 으로만 설정한다 (X2).
// source·curves는 자유롭게 patch 한다 — 파생 파일 생성은 서버가 문서를 훑어서 감시한다.
export const FORBIDDEN_PATCH_KEYS = [
  'kind', 'id', 'start', 'duration', 'in', 'out', 'speed', 'reversed',
  'freeze', 'loop', 'speedRamp',
] as const;

function doUpdateClip(d: ProjectDoc, clipId: string, patch: Record<string, unknown>): void {
  const { clip } = mustFindClip(d, clipId);
  for (const key of FORBIDDEN_PATCH_KEYS) {
    if (key in patch) fail('BAD_PATCH', `${key}는 updateClip으로 바꿀 수 없습니다`);
  }
  const target = clip as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) delete target[k];
    else target[k] = structuredClone(v);
  }
  assertValidDoc(d, 'BAD_PATCH');
}

function doSetKeyframes(d: ProjectDoc, clipId: string, keyframes: Keyframe[]): void {
  const { clip } = mustFindClip(d, clipId);
  for (const kf of keyframes) {
    // (1) 클립 종류별 허용 경로인가 (W8 S1)
    const rejection = keyframePathRejection(clip.kind, kf.prop);
    if (rejection) fail('BAD_KEYFRAME', rejection);
    // (2) 설정 시점에 대상이 실재하는가 — 오타(mask.wdith)와 「마스크를 안 켜고 마스크 키프레임」을 잡는다.
    //     (나중에 마스크를 지워서 무동작이 되는 것은 허용한다 — 그걸 막으면 마스크를 끄는 순간 문서가 무효가 된다.)
    if (readPath(clip, kf.prop) === undefined) {
      fail('BAD_KEYFRAME', `'${kf.prop}' 가 가리키는 값이 이 클립에 없습니다 — 먼저 그 값을 켜고 키프레임을 거세요`);
    }
    if (!Number.isInteger(kf.time) || kf.time < 0) {
      fail('BAD_KEYFRAME', `키프레임 time은 0 이상의 정수 ms여야 합니다 (받은 값: ${kf.time})`);
    }
  }
  clip.keyframes = structuredClone(keyframes).sort((a, b) => a.time - b.time);
}

// ── W5 명령 (X2) ──────────────────────────────────────────────────────────

/**
 * 정지화면 — `at`에서 클립을 나누고 그 사이에 정지 클립을 끼운다.
 * 결과 3조각: 왼쪽 / 정지(freeze:true, out===in+1, speed===1) / 오른쪽(start = at + duration).
 * 같은 트랙의 뒤쪽 클립들도 duration 만큼 뒤로 민다 (다른 트랙은 건드리지 않는다).
 */
function doFreezeFrame(
  d: ProjectDoc, clipId: string, at: number, duration: number, newClipIds?: [string, string],
): void {
  const { track, clip, index } = mustFindClip(d, clipId);
  if (clip.kind !== 'video') fail('BAD_COMMAND', 'freezeFrame은 video 클립에만 쓸 수 있습니다');
  if (clip.freeze === true || clip.loop === true || clip.speedRamp) {
    fail('BAD_FREEZE', '정지·루프·속도램프 클립에는 정지화면을 만들 수 없습니다');
  }
  if (!Number.isInteger(at)) fail('BAD_SPLIT', `정지 지점은 정수 ms여야 합니다 (받은 값: ${at})`);
  if (!Number.isInteger(duration) || duration <= 0) {
    fail('BAD_FREEZE', `정지 길이는 양의 정수 ms여야 합니다 (받은 값: ${duration})`);
  }
  const end = clip.start + clip.duration;
  if (at <= clip.start || at >= end) {
    fail('BAD_SPLIT', `정지 지점(${at})은 클립 내부(${clip.start}..${end})여야 합니다`);
  }
  // 새 id 2개 — 명령이 지정한 id를 그대로 써서 서버·모든 클라이언트에서 결정적이 되게 한다
  const freezeId = newClipIds?.[0] ?? newId();
  const rightId = newClipIds?.[1] ?? newId();
  if (freezeId === rightId) fail('DUPLICATE_ID', `정지 클립과 오른쪽 조각의 id가 같습니다: ${freezeId}`);
  for (const id of [freezeId, rightId]) {
    if (findClip(d, id)) fail('DUPLICATE_ID', `이미 존재하는 클립 id: ${id}`);
  }

  const leftDur = at - clip.start;
  const rightDur = end - at;
  // reversed video는 타임라인 t=0 ↔ 소스 out 이므로 분할점을 소스 반대 끝에서 계산한다 (splitClip과 같은 규칙)
  const mirrored = clip.reversed === true;
  const srcSpan = Math.round(leftDur * clip.speed);
  const srcSplit = mirrored ? clip.out - srcSpan : clip.in + srcSpan;
  if (srcSplit <= clip.in || srcSplit >= clip.out) {
    fail('BAD_SPLIT', '정지 결과 소스 구간이 비게 됩니다 (정지 지점이 너무 가장자리에 있습니다)');
  }
  const kf = splitKeyframes(clip.keyframes, leftDur);

  const left: VideoClip = mirrored
    ? { ...clip, duration: leftDur, in: srcSplit, keyframes: kf.left }
    : { ...clip, duration: leftDur, out: srcSplit, keyframes: kf.left };
  delete left.fadeOut;
  delete left.transitionOut;

  const right: VideoClip = mirrored
    ? { ...clip, id: rightId, start: at + duration, duration: rightDur, out: srcSplit, keyframes: kf.right }
    : { ...clip, id: rightId, start: at + duration, duration: rightDur, in: srcSplit, keyframes: kf.right };
  delete right.fadeIn;
  delete right.transitionIn;

  // 정지 클립: 소스 시각 srcSplit 의 한 프레임을 duration 내내 보여준다.
  // 경계 키프레임(time 0)만 남겨 값이 그 지점 그대로 유지되게 한다.
  const still: VideoClip = {
    ...clip, id: freezeId, start: at, duration,
    in: srcSplit, out: srcSplit + 1, speed: 1, freeze: true,
    keyframes: kf.right?.filter((k) => k.time === 0),
  };
  delete still.reversed;
  delete still.fadeIn;
  delete still.fadeOut;
  delete still.transitionIn;
  delete still.transitionOut;
  if (still.keyframes && still.keyframes.length === 0) delete still.keyframes;

  // 같은 트랙의 뒤쪽 클립을 duration 만큼 민다
  for (const c of track.clips) {
    if (c.id !== clip.id && c.start >= at) c.start += duration;
  }
  track.clips.splice(index, 1, left, still, right);
  sortAndCheckOverlap(track);
}

/** 속도 램프 설정/해제. points 검증 후 duration = rampDurationMs, null 이면 (out-in)/speed 로 복원. */
function doSetSpeedRamp(d: ProjectDoc, clipId: string, points: SpeedPoint[] | null): void {
  const { track, clip } = mustFindClip(d, clipId);
  if (clip.kind !== 'video') fail('BAD_COMMAND', 'setSpeedRamp는 video 클립에만 쓸 수 있습니다');
  if (clip.freeze === true || clip.loop === true) {
    fail('BAD_COMMAND', '정지·루프 클립에는 속도 램프를 쓸 수 없습니다');
  }
  if (points === null) {
    delete clip.speedRamp;
    const newDur = Math.round((clip.out - clip.in) / clip.speed);
    if (newDur <= 0) fail('BAD_RAMP', '램프 해제 결과 duration이 0이 됩니다');
    clip.duration = newDur;
  } else {
    if (!Array.isArray(points) || points.length < 2) fail('BAD_RAMP', '속도 램프는 최소 2점이어야 합니다');
    if (points[0]!.u !== 0) fail('BAD_RAMP', `첫 점의 u는 0이어야 합니다 (받은 값: ${points[0]!.u})`);
    const last = points[points.length - 1]!;
    if (last.u !== 1) fail('BAD_RAMP', `마지막 점의 u는 1이어야 합니다 (받은 값: ${last.u})`);
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (!Number.isFinite(p.u) || p.u < 0 || p.u > 1) fail('BAD_RAMP', `u는 0..1 범위여야 합니다 (받은 값: ${p.u})`);
      if (!Number.isFinite(p.speed) || p.speed < 0.1 || p.speed > 100) {
        fail('BAD_RAMP', `램프 speed는 0.1..100 범위여야 합니다 (받은 값: ${p.speed})`);
      }
      if (i > 0 && p.u <= points[i - 1]!.u) fail('BAD_RAMP', '램프 점의 u는 오름차순이어야 합니다');
    }
    clip.speedRamp = { points: structuredClone(points) };
    const newDur = rampDurationMs(clip);
    if (newDur <= 0) fail('BAD_RAMP', '램프 적용 결과 duration이 0이 됩니다');
    clip.duration = newDur;
  }
  sortAndCheckOverlap(track);
}

/**
 * `duckedBy` 사슬을 따라가 순환을 찾는다 (자기 자신 또는 A→B→A).
 * 순환이 있으면 렌더가 「어느 스템을 먼저 만들지」를 정할 수 없다.
 */
function assertNoDuckCycle(d: ProjectDoc, startId: string): void {
  const byId = new Map(d.tracks.map((t) => [t.id, t]));
  const seen = new Set<string>([startId]);
  const path = [startId];
  let cur = byId.get(startId)?.duckedBy;
  while (cur) {
    path.push(cur);
    if (seen.has(cur)) fail('BAD_DUCK', `더킹 관계가 순환합니다: ${path.join(' → ')}`);
    seen.add(cur);
    cur = byId.get(cur)?.duckedBy;
  }
}

/** 더킹 — voice 트랙 클립 구간의 합집합에서 music 트랙 클립의 volume 을 amount 배까지 낮춘다. */
function doDuckTrack(
  d: ProjectDoc, musicTrackId: string, voiceTrackId: string,
  amount: number, attackMs: number, releaseMs: number,
  intervalsIn?: DuckInterval[], curve?: DuckCurve, sidechain?: boolean,
): void {
  if (!Number.isFinite(amount) || amount < 0 || amount > 1) {
    fail('BAD_DUCK', `amount는 0..1 범위여야 합니다 (받은 값: ${amount})`);
  }
  for (const [name, v] of [['attackMs', attackMs], ['releaseMs', releaseMs]] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 5000) {
      fail('BAD_DUCK', `${name}는 0..5000 범위여야 합니다 (받은 값: ${v})`);
    }
  }
  if (musicTrackId === voiceTrackId) fail('BAD_DUCK', '음악 트랙과 목소리 트랙이 같습니다');
  const music = mustFindTrack(d, musicTrackId);
  const voice = mustFindTrack(d, voiceTrackId);

  // 포락선 구간을 받았으면 그것을 쓴다. 안 받았으면 「클립이 놓인 구간 전부」(W8 이전 동작).
  let intervals: DuckInterval[];
  if (intervalsIn === undefined) {
    intervals = voice.clips.map((c) => ({ start: c.start, end: c.start + c.duration }));
  } else {
    if (!Array.isArray(intervalsIn)) fail('BAD_DUCK', 'intervals는 배열이어야 합니다');
    for (const iv of intervalsIn) {
      if (!Number.isFinite(iv?.start) || !Number.isFinite(iv?.end) || iv.end < iv.start) {
        fail('BAD_DUCK', `더킹 구간이 올바르지 않습니다: ${JSON.stringify(iv)}`);
      }
    }
    intervals = intervalsIn.map((iv) => ({ start: iv.start, end: iv.end }));
  }

  // 사이드체인 설정(Track.duckedBy·duck)은 «명시했을 때만» 건드린다 — 미지정이면 그대로 둔다.
  if (sidechain !== undefined) {
    if (sidechain) {
      // 트리거가 안 들리면 눌릴 일이 없다 — 「켰는데 아무 일도 안 일어난다」를 여기서 막는다.
      if (voice.muted === true) fail('BAD_DUCK', '트리거(목소리) 트랙이 음소거되어 있습니다');
      music.duckedBy = voiceTrackId;
      // sidechaincompress 의 attack 상한이 2000ms 다 (release 는 9000 — 엔진 상한 5000 이 더 좁다).
      music.duck = { amount, attackMs: Math.min(2000, attackMs), releaseMs };
      assertNoDuckCycle(d, musicTrackId);
    } else {
      delete music.duckedBy;
      delete music.duck;
    }
  }

  for (const clip of music.clips) {
    if (clip.kind !== 'audio' && clip.kind !== 'video') continue;   // 볼륨이 있는 클립만
    const others = (clip.keyframes ?? []).filter((k) => k.prop !== 'volume');   // 다른 prop은 보존
    const ducked = duckKeyframes(clip, intervals, amount, attackMs, releaseMs, curve ?? 'linear');
    const merged = [...others, ...ducked].sort((a, b) => a.time - b.time);
    if (merged.length === 0) delete clip.keyframes;
    else clip.keyframes = merged;
  }
}

/** 텍스트 템플릿 적용 — style·animationIn/Out·transform·highlightColor 를 덮어쓴다(없는 필드는 삭제). */
function doApplyTextTemplate(d: ProjectDoc, clipId: string, templateId: string): void {
  const { clip } = mustFindClip(d, clipId);
  if (clip.kind !== 'text') fail('BAD_COMMAND', 'applyTextTemplate은 text 클립에만 쓸 수 있습니다');
  const tpl = TEXT_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) fail('TEMPLATE_NOT_FOUND', `텍스트 템플릿을 찾을 수 없습니다: ${templateId}`);
  clip.style = structuredClone(tpl.style);
  if (tpl.animationIn) clip.animationIn = structuredClone(tpl.animationIn);
  else delete clip.animationIn;
  if (tpl.animationOut) clip.animationOut = structuredClone(tpl.animationOut);
  else delete clip.animationOut;
  if (tpl.transform) clip.transform = structuredClone(tpl.transform);
  else delete clip.transform;
  if (tpl.highlightColor) clip.highlightColor = tpl.highlightColor;
  else delete clip.highlightColor;
  // text·words 는 건드리지 않는다
}

// ── 공개 API ──────────────────────────────────────────────────────────────

/** 명령 1개를 불변 적용한다. revision은 그대로 둔다. */
export function applyCommand(doc: ProjectDoc, cmd: Command): ProjectDoc {
  if (cmd.type === 'restoreDoc') {
    let next: ProjectDoc;
    try {
      next = validateDoc(cmd.doc);
    } catch (e) {
      fail('INVALID_DOC', `restoreDoc 문서가 유효하지 않습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
    next.id = doc.id;             // id는 기존 유지
    next.revision = doc.revision; // revision은 applyCommands가 관리
    return next;
  }

  const d = structuredClone(doc);
  switch (cmd.type) {
    case 'renameProject':
      d.name = cmd.name;
      break;
    case 'setSettings': {
      for (const [k, v] of Object.entries(cmd.settings)) {
        if (v !== undefined) (d.settings as unknown as Record<string, unknown>)[k] = structuredClone(v);
      }
      assertValidDoc(d, 'BAD_SETTINGS');
      break;
    }
    case 'addAsset':
      doAddAsset(d, cmd.asset);
      break;
    case 'removeAsset':
      doRemoveAsset(d, cmd.assetId);
      break;
    case 'updateAsset':
      doUpdateAsset(d, cmd.assetId, cmd.patch);
      break;
    case 'addTrack': {
      if (d.tracks.some((t) => t.id === cmd.track.id)) fail('DUPLICATE_ID', `이미 존재하는 트랙 id: ${cmd.track.id}`);
      const track: Track = { id: cmd.track.id, kind: cmd.track.kind, name: cmd.track.name, clips: [] };
      if (cmd.index === undefined) d.tracks.push(track);
      else d.tracks.splice(Math.max(0, Math.min(cmd.index, d.tracks.length)), 0, track);
      break;
    }
    case 'removeTrack': {
      const idx = d.tracks.findIndex((t) => t.id === cmd.trackId);
      if (idx < 0) fail('TRACK_NOT_FOUND', `트랙을 찾을 수 없습니다: ${cmd.trackId}`);
      d.tracks.splice(idx, 1);
      break;
    }
    case 'reorderTrack': {
      const idx = d.tracks.findIndex((t) => t.id === cmd.trackId);
      if (idx < 0) fail('TRACK_NOT_FOUND', `트랙을 찾을 수 없습니다: ${cmd.trackId}`);
      const [track] = d.tracks.splice(idx, 1);
      d.tracks.splice(Math.max(0, Math.min(cmd.index, d.tracks.length)), 0, track!);
      break;
    }
    case 'setTrackProps': {
      const track = mustFindTrack(d, cmd.trackId);
      const { name, volume, muted, locked, hidden } = cmd.patch;
      if (volume !== undefined && (volume < 0 || volume > 2)) fail('BAD_PATCH', 'volume은 0..2 범위여야 합니다');
      if (name !== undefined) track.name = name;
      if (volume !== undefined) track.volume = volume;
      if (muted !== undefined) track.muted = muted;
      if (locked !== undefined) track.locked = locked;
      if (hidden !== undefined) track.hidden = hidden;
      break;
    }
    case 'addClip':
      doAddClip(d, cmd.trackId, cmd.clip);
      break;
    case 'removeClip': {
      const { track, index } = mustFindClip(d, cmd.clipId);
      track.clips.splice(index, 1);
      break;
    }
    case 'moveClip':
      doMoveClip(d, cmd.clipId, cmd.start, cmd.trackId);
      break;
    case 'splitClip':
      doSplitClip(d, cmd.clipId, cmd.at, cmd.newClipId);
      break;
    case 'trimClip':
      doTrimClip(d, cmd.clipId, cmd.edge, cmd.to);
      break;
    case 'setClipSpeed':
      doSetClipSpeed(d, cmd.clipId, cmd.speed);
      break;
    case 'setReversed':
      doSetReversed(d, cmd.clipId, cmd.reversed);
      break;
    case 'updateClip':
      doUpdateClip(d, cmd.clipId, cmd.patch);
      break;
    case 'setKeyframes':
      doSetKeyframes(d, cmd.clipId, cmd.keyframes);
      break;
    case 'freezeFrame':
      doFreezeFrame(d, cmd.clipId, cmd.at, cmd.duration, cmd.newClipIds);
      break;
    case 'setSpeedRamp':
      doSetSpeedRamp(d, cmd.clipId, cmd.points);
      break;
    case 'duckTrack':
      doDuckTrack(
        d, cmd.musicTrackId, cmd.voiceTrackId, cmd.amount, cmd.attackMs, cmd.releaseMs,
        cmd.intervals, cmd.curve, cmd.sidechain,
      );
      break;
    case 'applyTextTemplate':
      doApplyTextTemplate(d, cmd.clipId, cmd.templateId);
      break;
    default: {
      const never: never = cmd;
      fail('BAD_COMMAND', `알 수 없는 명령: ${JSON.stringify(never)}`);
    }
  }
  return d;
}

/** 명령 배치를 원자적으로 전부 적용하고 revision을 +1 한다. 하나라도 실패하면 throw (원본 불변). */
export function applyCommands(doc: ProjectDoc, cmds: Command[]): ProjectDoc {
  let d = doc;
  for (const cmd of cmds) d = applyCommand(d, cmd);
  if (d === doc) {
    d = structuredClone(doc); // 빈 배치도 새 객체 반환
  } else {
    // 저장·브로드캐스트 전 최종 관문 — 스키마 위반 문서는 어떤 명령 조합으로도 나가지 못한다
    assertValidDoc(d, 'INVALID_DOC');
  }
  d.revision = doc.revision + 1;
  return d;
}

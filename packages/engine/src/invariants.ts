import type { ProjectDoc } from '@kitkat/schema';
import { isKeyframablePath } from '@kitkat/schema';
import { TRACK_ACCEPTS, assetPathFields, durationProblem } from './apply.js';

/** 문서 불변식 위반 목록을 돌려준다. 비어 있으면 정상. */
export function checkInvariants(doc: ProjectDoc): string[] {
  const problems: string[] = [];

  // 에셋: record 키 = id, 경로(derived 포함)에 백슬래시 금지, beats는 ms 오름차순
  for (const [key, asset] of Object.entries(doc.assets)) {
    if (asset.id !== key) problems.push(`에셋 키(${key})와 id(${asset.id})가 다릅니다`);
    for (const p of assetPathFields(asset)) {
      if (p != null && p.includes('\\')) problems.push(`에셋 ${asset.id}의 경로에 백슬래시가 있습니다: ${p}`);
    }
    if (asset.beats) {
      for (let i = 1; i < asset.beats.length; i++) {
        if (asset.beats[i]! <= asset.beats[i - 1]!) {
          problems.push(`에셋 ${asset.id}의 beats가 ms 오름차순이 아닙니다 (인덱스 ${i})`);
          break;
        }
      }
    }
  }

  // 배경 image 에셋 참조
  const bg = doc.settings.background;
  if (bg.kind === 'image' && !doc.assets[bg.assetId]) {
    problems.push(`배경이 존재하지 않는 에셋(${bg.assetId})을 참조합니다`);
  }

  const seenClipIds = new Set<string>();
  for (const track of doc.tracks) {
    for (let i = 0; i < track.clips.length; i++) {
      const clip = track.clips[i]!;

      if (seenClipIds.has(clip.id)) problems.push(`클립 id 중복: ${clip.id}`);
      seenClipIds.add(clip.id);

      // 트랙 kind ↔ 클립 kind
      if (!TRACK_ACCEPTS[track.kind].includes(clip.kind)) {
        problems.push(`트랙 "${track.name}"(${track.kind})에 ${clip.kind} 클립(${clip.id})이 있습니다`);
      }

      // 정렬·겹침
      if (i > 0) {
        const prev = track.clips[i - 1]!;
        if (clip.start < prev.start) {
          problems.push(`트랙 "${track.name}" 클립이 start 오름차순이 아닙니다 (${prev.id} → ${clip.id})`);
        } else if (clip.start < prev.start + prev.duration) {
          problems.push(`트랙 "${track.name}"에서 클립 ${prev.id}와 ${clip.id}가 겹칩니다`);
        }
      }

      // 죽은 assetId
      if ('assetId' in clip && !doc.assets[clip.assetId]) {
        problems.push(`클립 ${clip.id}이(가) 존재하지 않는 에셋(${clip.assetId})을 참조합니다`);
      }

      // video/audio: out>in, speed 범위, duration 불변식(freeze/loop 예외 · speedRamp ±2ms — X1)
      if (clip.kind === 'video' || clip.kind === 'audio') {
        if (clip.out <= clip.in) problems.push(`클립 ${clip.id}: out(${clip.out})이 in(${clip.in}) 이하입니다`);
        if (clip.speed < 0.1 || clip.speed > 100) problems.push(`클립 ${clip.id}: speed(${clip.speed})가 0.1..100 범위를 벗어납니다`);
        if (clip.kind === 'video' && clip.freeze === true && (clip.out !== clip.in + 1 || clip.speed !== 1)) {
          problems.push(`클립 ${clip.id}: freeze 클립은 out === in + 1, speed === 1 이어야 합니다`);
        }
        const problem = durationProblem(clip);
        if (problem) problems.push(`클립 ${clip.id}: ${problem}`);
      }

      // 키프레임 경로 호환 (W8 S1 — 열거형이 아니라 화이트리스트)
      if (clip.keyframes) {
        for (const kf of clip.keyframes) {
          if (!isKeyframablePath(clip.kind, kf.prop)) {
            problems.push(`클립 ${clip.id}(${clip.kind})에 허용되지 않는 키프레임 prop '${kf.prop}'`);
          }
        }
      }
    }
  }

  return problems;
}

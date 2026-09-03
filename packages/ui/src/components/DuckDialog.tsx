// 더킹 다이얼로그 — 목소리가 나올 때 음악을 자동으로 낮춘다 (duckTrack 명령)
//
// W8 F12:
//  · 구간을 「목소리 클립이 놓인 자리」가 아니라 **파형 포락선**에서 뽑는다(말 사이 공백에서
//    음악이 실제로 올라온다). Premiere 의 세 값(감쇠량·민감도·페이드)을 그대로 노출한다.
//  · 「진짜 사이드체인 컴프로 렌더」를 켜면 Track.duckedBy·duck 이 설정되고 렌더가 4단계가 된다.
//    **미리보기는 키프레임 근사** — PRD P3(결과물 무타협, 미리보기는 프록시) 그대로이고, 숨기지 않는다.
import { useState } from 'react';
import {
  voiceIntervalsFromEnvelope,
  DUCK_MIN_SPEECH_MS,
  DUCK_SENSITIVITY_MS,
  type DuckInterval,
  type VoiceEnvelope,
} from '@kitkat/engine';
import type { AudioClip, VideoClip } from '@kitkat/schema';
import { useEditor } from '../state.js';
import { loadWaveform, toEnvelope } from '../waveform.js';

const DEFAULT_AMOUNT = 0.25;   // 원래의 25% = -12dB (Premiere 의 기본 감쇠와 같은 자리)
const DEFAULT_FADE_MS = 400;   // Premiere 의 Fade Duration 권장 250~500ms 의 가운데
const MAX_ENVELOPE_MS = 5000;  // 엔진이 받는 attack/release 상한

/** 감쇠 배율 → dB (0.25 → "-12dB"). 어느 쪽 언어로 읽든 통하게 둘 다 적는다. */
function amountLabel(amount: number): string {
  if (amount <= 0) return '무음 (-∞dB)';
  const db = 20 * Math.log10(amount);
  return `원래의 ${Math.round(amount * 100)}% (${db.toFixed(1)}dB)`;
}

/**
 * 사이드체인 렌더 예상 시간 — 기준 실측(5초 1080×1920: 영상 22.2초 + 스템 21초×2 + 믹스 0.7초).
 *
 * **절대 초는 프로젝트마다 크게 다르다.** 같은 코드로 10초 프로젝트를 실제로 렌더해 보니
 * 216초(보통) / 406초(사이드체인) 로, 이 식이 내는 44초·130초의 3~5배였다.
 * 그래서 「몇 배 느려지는가」를 앞에 적고 초는 «어림»이라고 밝힌다 — 배수는 1.9~3배로 안정적이다.
 */
function estimateLabel(durationMs: number): string {
  const sec = Math.max(0, durationMs) / 1000;
  const plain = Math.round(sec * (22.24 / 5));
  const side = Math.round(sec * ((22.24 + 21 * 2 + 0.72) / 5));
  return `렌더가 약 ${(side / Math.max(1, plain)).toFixed(1)}배 느려집니다 (어림 ${plain}초 → ${side}초)`;
}

type Props = { onClose: () => void };

export function DuckDialog({ onClose }: Props) {
  const doc = useEditor((s) => s.doc);
  const dispatch = useEditor((s) => s.dispatch);

  const audioTracks = (doc?.tracks ?? []).filter((t) => t.kind === 'audio');
  const [musicTrackId, setMusicTrackId] = useState(audioTracks[0]?.id ?? '');
  const [voiceTrackId, setVoiceTrackId] = useState(audioTracks[1]?.id ?? '');
  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const [sensitivityMs, setSensitivityMs] = useState(DUCK_SENSITIVITY_MS);
  const [fadeMs, setFadeMs] = useState(DEFAULT_FADE_MS);
  const [sidechain, setSidechain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clampEnvelope = (n: number) => Math.min(MAX_ENVELOPE_MS, Math.max(0, Math.round(n)));
  const durationMs = (doc?.tracks ?? []).reduce(
    (max, t) => t.clips.reduce((m, c) => Math.max(m, c.start + c.duration), max),
    0,
  );

  /**
   * 목소리 트랙의 파형을 읽어 실제로 말하는 구간을 구한다.
   * 파형이 옛 형식이거나 아직 안 구워졌으면 `toEnvelope` 가 null 을 주고,
   * 엔진이 그 클립만 «클립 전체» 로 물러선다(조용히 근사하지 않는다).
   */
  const collectIntervals = async (): Promise<DuckInterval[] | undefined> => {
    const track = doc?.tracks.find((t) => t.id === voiceTrackId);
    if (!doc || !track) return undefined;
    const clips = track.clips.filter(
      (c): c is AudioClip | VideoClip => c.kind === 'audio' || c.kind === 'video',
    );
    if (clips.length === 0) return [];
    const envelopes: Record<string, VoiceEnvelope> = {};
    for (const clip of clips) {
      if (envelopes[clip.assetId]) continue;
      const src = doc.assets[clip.assetId]?.waveformSrc;
      if (!src) continue;
      const env = toEnvelope(await loadWaveform(src));
      if (env) envelopes[clip.assetId] = env;
    }
    return voiceIntervalsFromEnvelope(clips, envelopes, {
      sensitivityMs,
      minSpeechMs: DUCK_MIN_SPEECH_MS,
    });
  };

  const apply = () => {
    if (!musicTrackId || !voiceTrackId) {
      setError('음악 트랙과 목소리 트랙을 골라 주세요.');
      return;
    }
    if (musicTrackId === voiceTrackId) {
      setError('음악 트랙과 목소리 트랙은 서로 달라야 합니다.');
      return;
    }
    setBusy(true);
    void (async () => {
      const intervals = await collectIntervals();
      await dispatch([
        {
          type: 'duckTrack',
          musicTrackId,
          voiceTrackId,
          amount,
          attackMs: clampEnvelope(fadeMs),
          releaseMs: clampEnvelope(fadeMs),
          ...(intervals ? { intervals } : {}),
          // 램프를 컴프의 지수 곡선에 가깝게 — 렌더(사이드체인)와 덜 갈린다
          curve: 'comp',
          sidechain,
        },
      ]);
      setBusy(false);
      onClose();
    })();
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal-card" onPointerDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">더킹 — 목소리가 나올 때 음악 줄이기</h2>

        {audioTracks.length < 2 ? (
          <p className="dim">오디오 트랙이 2개 이상 있어야 합니다. (음악용·목소리용)</p>
        ) : (
          <>
            <div className="modal-row">
              <label>음악 트랙</label>
              <select value={musicTrackId} onChange={(e) => setMusicTrackId(e.target.value)}>
                {audioTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="modal-row">
              <label>목소리 트랙</label>
              <select value={voiceTrackId} onChange={(e) => setVoiceTrackId(e.target.value)}>
                <option value="">— 선택 —</option>
                {audioTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="modal-row">
              <label>감쇠량</label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
              <span className="modal-value">{amountLabel(amount)}</span>
            </div>
            <div className="modal-row">
              <label>민감도</label>
              <input
                type="range"
                min={0}
                max={1000}
                step={50}
                value={sensitivityMs}
                onChange={(e) => setSensitivityMs(Number(e.target.value))}
              />
              <span className="modal-value">
                {sensitivityMs}ms — 말 사이 이만큼의 틈은 이어진 것으로 봅니다
              </span>
            </div>
            <div className="modal-row">
              <label>페이드</label>
              <input
                type="range"
                min={0}
                max={1000}
                step={50}
                value={fadeMs}
                onChange={(e) => setFadeMs(Number(e.target.value))}
              />
              <span className="modal-value">{fadeMs}ms — 내려가고 올라오는 시간</span>
            </div>
            <div className="modal-row">
              <label>렌더 방식</label>
              <input
                type="checkbox"
                checked={sidechain}
                onChange={(e) => setSidechain(e.target.checked)}
              />
              <span className="modal-value">
                진짜 사이드체인 컴프로 렌더 — {estimateLabel(durationMs)}
              </span>
            </div>
            <p className="insp-note">
              미리보기는 키프레임 근사입니다
              {sidechain ? ' · 렌더는 진짜 사이드체인 컴프로 나갑니다.' : '.'}
            </p>
          </>
        )}

        {error && <span className="error-text">{error}</span>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            닫기
          </button>
          <button
            className="btn primary"
            onClick={apply}
            disabled={audioTracks.length < 2 || busy}
          >
            {busy ? '분석 중…' : '적용'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default DuckDialog;

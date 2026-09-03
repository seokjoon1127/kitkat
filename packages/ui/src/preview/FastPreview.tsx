// 프리뷰 v2 (실험) — WebCodecs/WebGL 경로의 미리보기 화면.
// 비디오·이미지는 <canvas> 에 WebGL2 로, 텍스트는 그 위 DOM 오버레이로 그린다.
// **기준선은 Remotion Player 다.** 여기서 정확히 못 그리는 것이 현재 시각에 있으면
// 모서리에 "정확 미리보기로 보세요" 배지를 띄운다.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, ImageClip, ProjectDoc, VideoClip } from '@kitkat/schema';
import {
  activeTransitionOverlays,
  activeTransitionStyles,
  docDurationMs,
  grainSeed,
  resolveMediaSrc,
} from '@kitkat/renderer/composition';
import { computeVisualLayout } from '@kitkat/renderer/layout';
import { useEditor } from '../state.js';
import { FrameProvider } from './decoder.js';
import { GlCompositor, type GlImage } from './gl.js';
import { transitionFlashes, transitionParams } from './gl-params.js';
import { parityKeys, parityNote } from './gl-parity.js';
import { AudioMixer, PlaybackClock, type AudioTarget } from './clock.js';
import {
  activeClipsAt,
  clipVolume,
  isStillClip,
  mediaTimeAt,
  playbackRateFor,
  videoHasAudio,
} from './timing.js';
import { TextClipOverlay } from './TextOverlay.js';
import { ScopeReader, previewFps, scopeBus } from './scope-source.js';

const MEDIA_BASE = '/media';
const PROXY = true;

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1] as string, 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

/** 렌더러 background.tsx 와 같은 규칙 — 맨 아래(배열 앞) 시각 트랙의 클립들. */
function bottomVisualClips(doc: ProjectDoc): (VideoClip | ImageClip)[] {
  for (const track of doc.tracks) {
    if (track.hidden === true) continue;
    if (track.kind !== 'video' && track.kind !== 'overlay') continue;
    const clips = track.clips.filter(
      (c): c is VideoClip | ImageClip => c.kind === 'video' || c.kind === 'image',
    );
    if (clips.length > 0) return clips;
  }
  return [];
}

type ViewState = { tMs: number; reasons: string[]; diffs: string[] };

export function FastPreview({ onGlFailure }: { onGlFailure: (message: string) => void }): JSX.Element {
  const doc = useEditor((s) => s.doc);
  const playing = useEditor((s) => s.playing);
  const playheadMs = useEditor((s) => s.playheadMs);
  const seek = useEditor((s) => s.seek);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<ProjectDoc | null>(doc);
  const playingRef = useRef(playing);
  const pushedRef = useRef(-1);
  const clockRef = useRef<PlaybackClock | null>(null);
  const providerRef = useRef<FrameProvider | null>(null);
  /** 정지 중에는 이 표시가 섰을 때만 다시 그린다 (문서 편집·시크·새 프레임 도착) */
  const dirtyRef = useRef(true);
  const [fit, setFit] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<ViewState>({ tMs: 0, reasons: [], diffs: [] });

  docRef.current = doc;
  playingRef.current = playing;

  const aspect = doc ? doc.settings.width / doc.settings.height : 16 / 9;
  const hasText = useMemo(
    () => (doc ? doc.tracks.some((t) => t.clips.some((c) => c.kind === 'text')) : false),
    [doc],
  );
  const hasTextRef = useRef(hasText);
  hasTextRef.current = hasText;

  // ── 표시 크기 (레터박스) ────────────────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = (): void => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const w = Math.min(r.width, r.height * aspect);
      setFit({ w: Math.floor(w), h: Math.floor(w / aspect) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  // ── 엔진 수명 ───────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = GlCompositor.create(canvas);
    if (!gl) {
      onGlFailure('WebGL2 를 쓸 수 없어 빠른 미리보기를 켤 수 없습니다. 정확 미리보기로 돌아갑니다.');
      return;
    }
    const provider = new FrameProvider({
      onFrameReady: () => {
        dirtyRef.current = true;
      },
    });
    providerRef.current = provider;
    // F14 검증용 손잡이 — **개발 서버에서만** 붙는다(빌드하면 이 블록이 통째로 사라진다).
    // 브라우저에서 스크럽 지연·VideoFrame 누수를 실제 편집기로 재려면 안쪽 공급기가 필요하다.
    // `__kitkatDraws` 에는 «그릴 때마다» {tMs, exact} 를 남긴다 — exact=false 면 그 화면의 비디오
    // 레이어 중 하나라도 요청한 시각이 아닌 이웃 프레임(또는 아무것도)을 그렸다는 뜻이다.
    type DrawLog = { tMs: number; exact: boolean; playing: boolean }[];
    const devWin = window as unknown as { __kitkatPreview?: unknown; __kitkatDraws?: DrawLog };
    if (import.meta.env.DEV) {
      devWin.__kitkatPreview = provider;
      devWin.__kitkatDraws = [];
    }
    const mixer = new AudioMixer(MEDIA_BASE);
    let lastReasons = '';
    let checkedGl = false;
    let failed = false;
    /** F6 실시간 스코프 — **보는 사람이 있을 때만** 만든다(없으면 읽기 비용이 0). */
    let reader: ScopeReader | null = null;
    scopeBus.onWake = () => {
      dirtyRef.current = true;
    };

    const draw = (tMs: number, isPlaying: boolean): void => {
      const d = docRef.current;
      if (!d) return;
      const W = d.settings.width;
      const H = d.settings.height;
      const fps = d.settings.fps;
      const frameIntervalMs = 1000 / fps;
      gl.resize(W, H);

      const bg = d.settings.background;
      gl.beginFrame(bg.kind === 'color' ? hexToRgb(bg.color) : [0, 0, 0]);

      const reasons = new Set<string>();
      const diffs = new Set<string>();
      const texIds = new Set<string>();

      // ── 배경 ──
      if (bg.kind === 'image') {
        const asset = d.assets[bg.assetId];
        if (asset) {
          const img = provider.image(`${MEDIA_BASE}/${asset.src}`);
          if (img) {
            const id = `bg-${asset.id}`;
            texIds.add(id);
            gl.drawCover({ id, image: img, seq: 0, srcW: 0, srcH: 0, blurPx: 0, zoom: 1 });
          }
        }
      } else if (bg.kind === 'blur') {
        reasons.add('배경 블러(근사)');
        for (const clip of bottomVisualClips(d)) {
          if (tMs < clip.start || tMs >= clip.start + clip.duration) continue;
          const asset = d.assets[clip.assetId];
          if (!asset) continue;
          const local = tMs - clip.start;
          const id = `bg-${clip.id}`;
          let image: GlImage | null = null;
          let seq = 0;
          if (clip.kind === 'image') {
            image = provider.image(resolveMediaSrc(clip, asset, MEDIA_BASE, PROXY).src);
          } else {
            const mt = mediaTimeAt(clip, asset, MEDIA_BASE, PROXY, local);
            // 엘리먼트는 본 클립과 **같은 것을 쓴다**(key = clip.id) — 같은 파일을 두 번 디코드하지 않는다.
            // 소리 설정은 아래 시각 클립 루프가 덮어쓴다(배경이 먼저 그려지므로).
            const r = provider.frame({
              key: clip.id,
              src: mt.src,
              srcMs: mt.srcMs,
              frameIntervalMs,
              playing: isPlaying && !isStillClip(clip),
              rate: playbackRateFor(clip),
              muted: true,
              volume: 0,
            });
            image = r.image;
            seq = r.seq;
          }
          if (!image) continue;
          texIds.add(id);
          gl.drawCover({
            id,
            image,
            seq,
            srcW: asset.width ?? 0,
            srcH: asset.height ?? 0,
            blurPx: bg.amount,
            zoom: 1.15,
          });
        }
      }

      // ── 시각 클립 ──
      const active = activeClipsAt(d, tMs);
      const liveKeys = new Set<string>();
      let videoExact = true;
      for (const a of active.visual) {
        const asset: Asset | undefined = d.assets[a.clip.assetId];
        if (!asset) continue;
        const layout = computeVisualLayout({
          clip: a.clip,
          asset,
          canvasW: W,
          canvasH: H,
          tMs: a.localMs,
        });
        const tp = transitionParams(
          activeTransitionStyles(
            a.localMs,
            a.clip.duration,
            a.clip.transitionIn,
            a.clip.transitionOut,
          ) as Record<string, unknown>[],
          W,
          H,
        );

        let image: GlImage | null = null;
        let seq = 0;
        if (a.clip.kind === 'image') {
          image = provider.image(resolveMediaSrc(a.clip, asset, MEDIA_BASE, PROXY).src);
        } else {
          const clip = a.clip;
          const mt = mediaTimeAt(clip, asset, MEDIA_BASE, PROXY, a.localMs);
          const audible = videoHasAudio(clip) && a.track.muted !== true;
          const r = provider.frame({
            key: clip.id,
            src: mt.src,
            srcMs: mt.srcMs,
            frameIntervalMs,
            playing: isPlaying && !isStillClip(clip),
            rate: playbackRateFor(clip),
            muted: !isPlaying || !audible,
            volume: audible ? clipVolume(clip, a.track, a.localMs) : 0,
          });
          image = r.image;
          seq = r.seq;
          liveKeys.add(clip.id);
          if (!r.image || !r.exact) videoExact = false;
        }
        if (!image) continue;
        texIds.add(a.clip.id);
        for (const why of gl.drawLayer({
          id: a.clip.id,
          image,
          seq,
          layout,
          transition: tp,
          // 렌더러 오버레이와 **같은 시드** — 프레임마다 그레인이 바뀌는 것도 같이 간다
          grainSeed: grainSeed(Math.round((tMs / 1000) * fps)),
        })) {
          reasons.add(why);
        }
        const flash = transitionFlashes(
          activeTransitionOverlays(
            a.localMs,
            a.clip.duration,
            a.clip.transitionIn,
            a.clip.transitionOut,
          ) as { key: string; style: Record<string, unknown> }[],
        );
        for (const f of flash.flashes) gl.drawFlash(f.color, f.opacity);
        // 글리치 찢김 덮개 (W8 F15 #8) — 예전엔 「미지원」 배지였다
        if (flash.glitch) gl.drawGlitch(flash.glitch);
        for (const why of flash.approx) reasons.add(why);
        // 「못 그림」이 아니라 **얼마나 다른가** — 대조 테스트 실측값을 배지에 띄운다
        const note = parityNote(parityKeys(layout, flash.glitch !== null));
        if (note) diffs.add(note);
      }

      gl.retain(texIds);
      if (import.meta.env.DEV && devWin.__kitkatDraws) {
        devWin.__kitkatDraws.push({ tMs, exact: videoExact, playing: isPlaying });
        if (devWin.__kitkatDraws.length > 6000) devWin.__kitkatDraws.splice(0, 2000);
      }
      // 정지하면 모든 엘리먼트를 세운다 — 안 그러면 소리가 계속 난다
      if (isPlaying) provider.pauseUnused(liveKeys);
      else provider.pauseAll();
      const audioTargets: AudioTarget[] = active.audio
        .filter((a): a is AudioTarget => a.clip.kind === 'audio')
        .map((a) => ({ clip: a.clip, track: a.track, localMs: a.localMs }));
      mixer.sync(audioTargets, d.assets, isPlaying);

      // 첫 프레임을 다 그린 뒤 WebGL 오류를 확인한다 — 여기서 안 잡으면 까만 화면으로 조용히 실패한다
      if (!checkedGl && active.visual.length > 0) {
        checkedGl = true;
        const err = gl.consumeError();
        if (err !== 0) {
          failed = true;
          onGlFailure(`빠른 미리보기에서 WebGL 오류(0x${err.toString(16)})가 나 정확 미리보기로 돌아갑니다.`);
          return;
        }
      }

      // ── F6 실시간 스코프 ──
      // 합성이 다 끝난 «지금» 걸어야 화면과 같은 픽셀을 읽는다. 걸기만 하고 기다리지 않는다.
      // 정지 중에는 그리는 일 자체가 «바뀐 프레임» 이므로 주기를 건너뛴다(force).
      if (scopeBus.wanted) {
        if (!reader) reader = new ScopeReader(gl.context);
        reader.sample(tMs, !isPlaying);
      } else if (reader) {
        reader.dispose();
        reader = null;
      }

      const joined = `${[...reasons].join('|')}#${[...diffs].join('|')}`;
      const reasonsChanged = joined !== lastReasons;
      lastReasons = joined;
      if (reasonsChanged || hasTextRef.current) {
        setView({ tMs, reasons: [...reasons], diffs: [...diffs] });
      }
    };

    const clock = new PlaybackClock({
      getDurationMs: () => (docRef.current ? docDurationMs(docRef.current) : 0),
      onEnded: () => useEditor.setState({ playing: false }),
      onTick: (tMs, isPlaying) => {
        if (failed) return;
        previewFps.push(performance.now(), isPlaying);
        if (isPlaying || dirtyRef.current) {
          dirtyRef.current = false;
          draw(tMs, isPlaying);
        }
        // 스코프 수거는 «그리기와 따로» — 정지 중에도(다시 안 그려도) 결과가 도착한다.
        if (reader) {
          const s = reader.poll();
          if (s) scopeBus.publish(s);
        }
        if (isPlaying) {
          const rounded = Math.round(tMs);
          if (rounded !== pushedRef.current) {
            pushedRef.current = rounded;
            seek(rounded);
          }
        }
      },
    });
    clockRef.current = clock;
    clock.seek(useEditor.getState().playheadMs);
    pushedRef.current = Math.round(useEditor.getState().playheadMs);
    clock.start();
    if (useEditor.getState().playing) clock.play();

    return () => {
      clock.stop();
      clockRef.current = null;
      scopeBus.onWake = null;
      reader?.dispose();
      reader = null;
      mixer.dispose();
      providerRef.current = null;
      provider.dispose();
      gl.dispose();
    };
    // onGlFailure/seek 는 스토어 함수라 안정적이다 — 엔진은 마운트당 한 번만 만든다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 문서가 바뀌면(효과·트랜스폼 편집 등) 정지 중이라도 다시 그린다.
  // 그리고 영상 파일들을 **미리 열어 둔다** — 재생헤드가 닿고 나서 열면 그동안 화면이 끊긴다.
  useEffect(() => {
    dirtyRef.current = true;
    if (!doc) return;
    const srcs: { start: number; src: string; srcMs: number }[] = [];
    for (const track of doc.tracks) {
      if (track.hidden === true) continue;
      for (const clip of track.clips) {
        if (clip.kind !== 'video') continue;
        const asset = doc.assets[clip.assetId];
        if (!asset) continue;
        const mt = mediaTimeAt(clip, asset, MEDIA_BASE, PROXY, 0); // 클립 첫 프레임의 소스 시각
        srcs.push({ start: clip.start, src: mt.src, srcMs: mt.srcMs });
      }
    }
    srcs.sort((a, b) => a.start - b.start);
    // 같은 파일은 제일 먼저 오는 클립의 시작 시각으로 한 번만
    const seen = new Set<string>();
    const items = srcs.filter((s) => (seen.has(s.src) ? false : (seen.add(s.src), true)));
    providerRef.current?.prewarm(items.map((s) => ({ src: s.src, srcMs: s.srcMs })));
  }, [doc]);

  // 재생/일시정지 반영
  useEffect(() => {
    const c = clockRef.current;
    if (!c) return;
    if (playing) c.play();
    else c.pause();
    dirtyRef.current = true;
  }, [playing]);

  // 외부 시크 (타임라인 클릭·프레임 이동) 반영 — 우리가 밀어 넣은 값은 무시
  useEffect(() => {
    const c = clockRef.current;
    if (!c) return;
    if (Math.round(playheadMs) === pushedRef.current) return;
    pushedRef.current = Math.round(playheadMs);
    c.seek(playheadMs);
    dirtyRef.current = true;
  }, [playheadMs]);

  const texts = doc ? activeClipsAt(doc, view.tMs).text : [];

  return (
    <div
      ref={wrapRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ position: 'relative', width: fit.w || '100%', height: fit.h || '100%' }}>
        <canvas
          ref={canvasRef}
          style={{ display: 'block', width: '100%', height: '100%', background: '#000' }}
        />
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
          {texts.map((t) => (
            <TextClipOverlay
              key={t.clip.id}
              clip={t.clip}
              tMs={t.localMs}
              canvasW={fit.w}
              canvasH={fit.h}
            />
          ))}
        </div>
        {view.reasons.length > 0 || view.diffs.length > 0 ? (
          <div
            title={[...view.reasons, ...view.diffs].join(' · ')}
            style={{
              position: 'absolute',
              right: 8,
              bottom: 8,
              maxWidth: '80%',
              padding: '4px 8px',
              borderRadius: 6,
              fontSize: 11,
              lineHeight: 1.3,
              background: 'rgba(20,20,24,0.82)',
              // 「못 그림」은 노란 경고, 「이만큼 다름」은 회색 안내 — 급이 다르다
              color: view.reasons.length > 0 ? '#ffd45e' : '#c8ccd4',
              border:
                view.reasons.length > 0
                  ? '1px solid rgba(255,212,94,0.35)'
                  : '1px solid rgba(200,204,212,0.25)',
              pointerEvents: 'none',
            }}
          >
            {view.reasons.length > 0
              ? `이 구간은 정확 미리보기로 보세요 (${view.reasons.join(', ')})`
              : view.diffs.join(' · ')}
          </div>
        ) : null}
      </div>
    </div>
  );
}

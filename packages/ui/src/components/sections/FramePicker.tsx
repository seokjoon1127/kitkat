// 클립의 «실제 화면» 위에서 사각형을 드래그하거나 픽셀을 찍는 공용 위젯 (W8 F4 영역 지정 · F5 스포이드).
//
// 배경으로 에셋 썸네일(`/media/thumbs/<id>.jpg`, 서버가 임포트 직후 굽는다)을 쓴다.
// 플레이어 위에 그리지 않는 이유: 기준 클립의 영역을 그리려면 플레이어를 그 컷으로 옮겨야 하는데,
// 대상 컷과 기준 컷의 영역을 «번갈아» 그리는 작업이라 화면이 계속 튄다.
// 썸네일은 인스펙터 안에 둘 다 나란히 놓을 수 있고, 좌표계(0..1 전체 프레임)도 같다.
import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Asset, Crop } from '@kitkat/schema';
import { normalizeRegion } from './inspector-utils.js';

export type FramePickerProps = {
  asset: Asset | undefined;
  /** 현재 사각형(0..1). 없으면 전체를 뜻한다. */
  region?: Crop;
  /** 드래그가 끝나면 부른다. 'rect' 모드에서만 */
  onRegion?: (r: Crop | undefined) => void;
  /** 픽셀을 찍으면 부른다 (스포이드). 주면 클릭이 사각형 대신 픽셀 뽑기로 동작한다. */
  onPick?: (rgb: [number, number, number]) => void;
  label?: string;
};

/** 이미지에서 (u,v) 위치의 픽셀 RGB 를 읽는다. 캔버스는 매번 새로 만든다(1회용). */
function readPixel(img: HTMLImageElement, u: number, v: number): [number, number, number] | null {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const x = Math.min(canvas.width - 1, Math.max(0, Math.floor(u * canvas.width)));
  const y = Math.min(canvas.height - 1, Math.max(0, Math.floor(v * canvas.height)));
  try {
    const d = ctx.getImageData(x, y, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!];
  } catch {
    return null; // 다른 오리진 이미지 — 여기서는 같은 오리진(/media)이라 실제로는 안 난다
  }
}

export function FramePicker({ asset, region, onRegion, onPick, label }: FramePickerProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);

  const thumb = asset?.thumbSrc;
  if (!thumb || failed) {
    return (
      <p className="insp-note">
        {label ? `${label}: ` : ''}
        미리보기 이미지가 아직 없습니다 — 영역 대신 화면 전체를 잽니다.
      </p>
    );
  }

  const uv = (e: ReactPointerEvent): { u: number; v: number } => {
    const rect = boxRef.current!.getBoundingClientRect();
    return {
      u: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      v: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const onDown = (e: ReactPointerEvent) => {
    if (onPick) {
      const { u, v } = uv(e);
      const img = imgRef.current;
      const rgb = img ? readPixel(img, u, v) : null;
      if (rgb) onPick(rgb);
      return;
    }
    if (!onRegion) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { u, v } = uv(e);
    setDrag({ x: u, y: v, w: 0, h: 0 });
  };

  const onMove = (e: ReactPointerEvent) => {
    if (!drag || onPick) return;
    const { u, v } = uv(e);
    setDrag({ ...drag, w: u - drag.x, h: v - drag.y });
  };

  const onUp = (e: ReactPointerEvent) => {
    if (!drag || !onRegion) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const r = normalizeRegion(drag);
    setDrag(null);
    // 거의 안 움직였으면 «영역 해제» 로 읽는다 (클릭 한 번으로 전체로 되돌리기)
    onRegion(r.w < 0.02 || r.h < 0.02 ? undefined : r);
  };

  const shown = drag ?? region;
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

  return (
    <div className="insp-frame">
      {label ? <span className="insp-frame-label">{label}</span> : null}
      <div
        ref={boxRef}
        className={`insp-frame-box${onPick ? ' is-pick' : ''}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        <img
          ref={imgRef}
          className="insp-frame-img"
          src={`/media/${thumb}`}
          alt=""
          draggable={false}
          crossOrigin="anonymous"
          onError={() => setFailed(true)}
        />
        {shown ? (
          <div
            className="insp-frame-rect"
            style={{
              left: pct(Math.min(shown.x, shown.x + shown.w)),
              top: pct(Math.min(shown.y, shown.y + shown.h)),
              width: pct(Math.abs(shown.w)),
              height: pct(Math.abs(shown.h)),
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

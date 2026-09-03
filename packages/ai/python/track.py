# 마스크 모션 트래킹 (W8 F10) — OpenCV TrackerVit + PyAV 디코딩.
#
# stdout: JSON {"fps", "width", "height", "frames":[{"frame","ms","x","y","w","h","score"}]}
# stderr: 진행률 한 줄 규약 `PROGRESS <0..1> <끝난 프레임> <전체 프레임>`
#         (그 외 stderr 는 오류 메시지로 취급된다)
#
# 좌표는 **소스 파일의 픽셀 그대로**다. 정규화·크롭 보정은 노드가 한다
# (파이썬이 kitkat 의 레이아웃 규칙을 알 필요가 없다).
#
# **추적 성공/실패 판정은 여기서 하지 않는다.** 점수와 상자를 «있는 그대로» 내보내고
# 판정은 노드의 classifyTrack 이 한다 — 판정 규칙(점수·상자 온전성·연쇄)은 opencv 없이
# 단위 테스트할 수 있어야 하고, 실측으로 값을 바꿀 일이 잦기 때문이다.
#
# 왜 TrackerNano 가 아닌가: Nano 는 어떤 상황에서도 0.9 점수만 돌려줘 **추적 실패를 알 수 없다.**
# 편집기는 「여기서부터 놓쳤습니다」를 보여줘야 하므로 신뢰도를 주는 ViT 를 쓴다.
#
# ── 역방향 추적 (--direction backward) ────────────────────────────────────────
#
# 영상은 **뒤로 디코드할 수 없다** (P/B 프레임이 앞 프레임에 기대므로 키프레임부터 앞으로
# 풀어야 한다). 그렇다고 구간 전체를 메모리에 올리면 1080×1920 900프레임이 5.6GB 다.
#
# **창(window) 단위로 앞으로 풀고, 창 안에서만 뒤로 훑는다.** 창 하나를 다 쓰면 버리고
# 그 앞의 창으로 옮긴다 — 어느 순간에도 메모리에 있는 것은 창 하나뿐이다.
#
#   기준 프레임 ────────────────────────────────────────▶ (여기서 tracker.init)
#   [   창 N-2   ][   창 N-1   ][    창 N    ] 기준
#        ③◀──────      ②◀──────     ①◀──────         (추적 방향)
#        ─────▶디코드  ─────▶디코드  ─────▶디코드      (디코드 방향)
#
# 링에는 **디코드된 그대로의 VideoFrame** 을 담고, 추적기에 넣을 bgr24 ndarray 변환은
# 추적 직전에 «한 장씩»만 한다 — 창 전체를 ndarray 로 들고 있지 않으려는 것이다.
# (실측: 720p 에서 창을 15 → 30 으로 늘리면 최대 RSS 가 41MB 늘어난다 = 프레임당 2.7MB.
#  yuv420p 한 장 1.38MB 의 두 배쯤인데, 디코더가 참조 프레임을 따로 쥐고 있기 때문이다.
#  창 크기를 정할 때는 이 «프레임당 2.7MB(720p) · 6.2MB(1080×1920)» 를 쓰면 맞는다.)
import argparse
import json
import sys


EXIT_MISSING_DEP = 3

# 역방향 창 크기(프레임). **30 은 재서 정한 값이다** (2026-09-03, 합성 450프레임).
#
# | 소스 | 방향·창 | ms/프레임 | 최대 RSS |
# |------|--------|-----------|---------|
# | 1280×720 GOP30   | forward     | 14.62 | 117MB |
# |                  | backward 15 | 29.51 | 143MB |
# |                  | **backward 30** | **24.61** | **184MB** |
# |                  | backward 60 | 29.71 | 264MB |
# | 1080×1920 GOP30  | forward     | 23.07 | 164MB |
# |                  | backward 15 | 45.98 | 217MB |
# |                  | **backward 30** | **34.44** | **285MB** |
# |                  | backward 60 | 55.52 | 423MB |
# | 1080×1920 GOP250 | forward     | 30.39 | 166MB |
# |                  | backward 30 | 78.63 | 285MB |
#
# 창을 키우면 창 하나를 채우려고 키프레임부터 다시 푸는 «헛디코딩»이 줄어 빨라질 것 같지만,
# **60 에서 오히려 느려진다**(1080×1920 에서 34.4 → 55.5ms). 창이 423MB 를 잡으면서
# 프레임 버퍼 재사용이 무너지는 쪽이 더 크다. 15 는 헛디코딩이 많아 느리다.
# **30 이 두 해상도 모두에서 제일 빠르고 500MB 아래를 크게 남긴다.**
#
# 4K(3840×2160)는 프레임 한 장이 1080×1920 의 4배라 창 30 이 500MB 를 넘길 수 있다.
# 그때는 --window 로 줄여 준다 (한 장에 비례해 줄어든다).
DEFAULT_WINDOW = 30


def eprint_progress(done: int, total) -> None:
    """`PROGRESS <0..1> <done> <total>` — 총 프레임 수를 모르면 total 을 0 으로 낸다."""
    p = min(1.0, done / total) if total else 0.0
    sys.stderr.write("PROGRESS %.4f %d %d\n" % (p, done, total or 0))
    sys.stderr.flush()


def decode_range(container, stream, fps, lo, hi):
    """프레임 [lo..hi] 를 **앞으로** 디코드해 `(idx, frame)` 으로 내보낸다.

    seek 은 키프레임 단위라 lo 보다 앞에서 시작한다 → pts 로 걸러 낸다.
    lo 에 정확히 해당하는 프레임이 없을 수도 있으므로(가변 프레임률·반올림)
    **lo 이상인 첫 프레임은 hi 를 넘더라도 한 장은 내보낸다** — 기준 프레임을
    한 장만 뽑을 때 빈손으로 끝나지 않게 하는 것이다.
    """
    if stream.time_base:
        offset = int((lo / fps) / float(stream.time_base))
        container.seek(max(0, offset), stream=stream, backward=True, any_frame=False)
    started = False
    for frame in container.decode(stream):
        pts = frame.pts
        if pts is None:
            continue
        idx = int(round(float(pts * stream.time_base) * fps))
        if idx < lo:
            continue
        if started and idx > hi:
            break
        started = True
        yield idx, frame
        if idx >= hi:
            break


class Updater:
    """`tracker.update` 한 번. **죽지 않고 실패로 기록한다.**

    대상을 «완전히» 놓치면(화면 밖으로 나가는 등) ViT 가 말이 안 되는 상자를 돌려주고,
    그 상자로 다음 프레임을 잘라내려다 «29GB 할당» 으로 프로세스가 통째로 죽는다.
    죽으면 사용자는 「추적 실패」가 아니라 「track.py 실행 실패」를 본다 — 어디서 놓쳤는지가
    결과의 일부인데 그 결과가 통째로 사라진다.

    그래서 한 번 터지면 그 뒤는 **0 크기 상자·점수 0** 으로 내보낸다. 노드의 classifyTrack 이
    폭·높이가 1 이하인 상자를 실패로 보므로 UI 에 「여기서부터 놓쳤습니다」로 그려진다.
    (ViT 는 놓친 대상으로 스스로 돌아오지 못하므로 다시 시도하지 않는다.)
    """

    def __init__(self, cv2, tracker):
        self.cv2 = cv2
        self.tracker = tracker
        self.dead = False

    def __call__(self, img):
        if self.dead:
            return (0.0, 0.0, 0.0, 0.0), 0.0
        try:
            _ok, box = self.tracker.update(img)
            return box, self.tracker.getTrackingScore()
        except self.cv2.error:
            self.dead = True
            return (0.0, 0.0, 0.0, 0.0), 0.0


def row(idx, sec, box, score):
    x, y, w, h = box
    return {
        "frame": int(idx), "ms": int(round(sec * 1000)),
        "x": float(x), "y": float(y), "w": float(w), "h": float(h),
        "score": float(score),
    }


def track_forward(container, stream, fps, tracker, update, box, start_frame, end_frame, stride):
    """기준 프레임에서 **앞으로**. 한 번의 디코드 패스로 끝난다(링이 필요 없다)."""
    total = end_frame - start_frame + 1 if end_frame is not None else None
    out = []
    done = 0
    initialised = False
    hi = end_frame if end_frame is not None else float("inf")
    for idx, frame in decode_range(container, stream, fps, start_frame, hi):
        sec = float(frame.pts * stream.time_base)
        if initialised and stride > 1 and (idx - start_frame) % stride != 0:
            continue
        img = frame.to_ndarray(format="bgr24")
        if not initialised:
            x, y, w, h = box
            tracker.init(img, (int(round(x)), int(round(y)), int(round(w)), int(round(h))))
            initialised = True
            # 기준 프레임은 사용자가 찍어 준 상자 그대로 — 점수 1.0 은 「의심할 여지 없음」이다.
            out.append(row(idx, sec, box, 1.0))
        else:
            b, score = update(img)
            # 낮은 점수의 프레임도 «빠뜨리지 않고» 넣는다 — 어디서 놓쳤는지가 결과의 일부다.
            out.append(row(idx, sec, b, score))
        done += 1
        if done % 15 == 0:
            eprint_progress(done, total)
    return out, done, total


def track_backward(container, stream, fps, tracker, update, box, start_frame, end_frame, stride, window):
    """기준 프레임에서 **뒤로**. 창 단위로 앞으로 디코드하고 창 안에서 뒤로 훑는다.

    나오는 순서는 **추적한 순서**다 — 기준 프레임이 먼저, 그 뒤는 프레임 번호가 줄어든다.
    노드의 classifyTrack 이 「3연속 실패 뒤는 전부 실패」를 «추적 순서» 로 판정하므로
    시간순으로 뒤집어 주면 그 규칙이 뒤집힌다. 시간순 정렬은 판정 뒤에 노드가 한다.
    """
    low = max(0, end_frame if end_frame is not None else 0)
    out = []

    # ① 기준 프레임 한 장만 뽑아 tracker.init
    anchor_idx = None
    for idx, frame in decode_range(container, stream, fps, start_frame, start_frame):
        anchor_idx = idx
        x, y, w, h = box
        img = frame.to_ndarray(format="bgr24")
        tracker.init(img, (int(round(x)), int(round(y)), int(round(w)), int(round(h))))
        out.append(row(idx, float(frame.pts * stream.time_base), box, 1.0))
        break
    if anchor_idx is None:
        return out, 0, 0

    total = anchor_idx - low + 1
    done = 1

    # ② 창을 뒤로 옮기며 훑는다
    cur_hi = anchor_idx - 1
    while cur_hi >= low:
        cur_lo = max(low, cur_hi - window + 1)
        gen = decode_range(container, stream, fps, cur_lo, cur_hi)
        # 링 = 창 하나. 여기 담기는 것은 **디코드된 그대로의 프레임**(yuv420p)이다.
        ring = [(i, f) for i, f in gen if i <= cur_hi]
        gen.close()
        for idx, frame in reversed(ring):
            if stride > 1 and (anchor_idx - idx) % stride != 0:
                continue
            b, score = update(frame.to_ndarray(format="bgr24"))
            out.append(row(idx, float(frame.pts * stream.time_base), b, score))
            done += 1
            if done % 15 == 0:
                eprint_progress(done, total)
        del ring  # 창을 즉시 놓는다 — 다음 창을 채우기 «전에» 놓아야 최대 RSS 가 창 하나다
        cur_hi = cur_lo - 1
    return out, done, total


def main() -> None:
    ap = argparse.ArgumentParser(description="TrackerVit object tracking -> JSON on stdout")
    ap.add_argument("media", help="absolute path to video file")
    ap.add_argument("--box", nargs=4, type=float, required=True,
                    metavar=("X", "Y", "W", "H"), help="start box in SOURCE pixels")
    # 시각은 **ms 로 받는다** — 서버가 fps 를 알려고 ffprobe 를 한 번 더 돌리지 않게 하려는 것.
    # 출력에는 frame 과 ms 를 «둘 다» 넣는다.
    ap.add_argument("--start-ms", type=int, default=0, help="source ms of --box (anchor)")
    # forward 면 --end-ms 가 «뒤쪽» 끝, backward 면 «앞쪽» 끝이다 (둘 다 포함).
    ap.add_argument("--end-ms", type=int, default=None,
                    help="inclusive far bound (forward: last ms, default EOF / backward: first ms, default 0)")
    ap.add_argument("--direction", choices=("forward", "backward"), default="forward",
                    help="forward (default) = anchor 뒤로, backward = anchor 앞으로")
    ap.add_argument("--window", type=int, default=DEFAULT_WINDOW,
                    help="backward 창 크기(프레임). 메모리 = 창 × 프레임 한 장 (기본 %d)" % DEFAULT_WINDOW)
    ap.add_argument("--model", required=True, help="path to object_tracking_vittrack_*.onnx")
    # 기본은 «매 프레임» 이다. 건너뛰기는 사용자가 명시적으로 켜는 옵션이지 속도를 이유로 한
    # 기본값이 아니다 — 건너뛴 사이는 키프레임 선형보간으로 메워지므로 정확도가 떨어진다.
    ap.add_argument("--stride", type=int, default=1,
                    help="track every Nth frame (default 1 = every frame)")
    args = ap.parse_args()

    try:
        import av  # noqa: F401
        import cv2
        import numpy as np  # noqa: F401
    except ImportError as e:
        sys.stderr.write("tracker dependency missing: %s (run prewarm tracker)\n" % e)
        sys.exit(EXIT_MISSING_DEP)

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    stride = max(1, args.stride)
    window = max(1, args.window)

    params = cv2.TrackerVit.Params()
    params.net = args.model
    # 점수 임계는 «노드가» 판정한다. 트래커 내부 임계를 올리면 낮은 점수의 상자를
    # 아예 안 돌려줘서 「어디서 놓쳤는지」를 못 그린다 — 그게 결과의 일부다.
    params.tracking_score_threshold = 0.0
    try:
        tracker = cv2.TrackerVit.create(params)
    except cv2.error as e:
        sys.stderr.write("TrackerVit 모델을 열지 못했습니다: %s\n" % e)
        sys.exit(EXIT_MISSING_DEP)

    container = av.open(args.media)
    try:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        rate = stream.average_rate or stream.guessed_rate
        fps = float(rate) if rate else 30.0
        width = int(stream.codec_context.width)
        height = int(stream.codec_context.height)

        start_frame = max(0, int(round(args.start_ms / 1000.0 * fps)))
        end_frame = int(round(args.end_ms / 1000.0 * fps)) if args.end_ms is not None else None

        update = Updater(cv2, tracker)
        if args.direction == "backward":
            frames_out, done, total = track_backward(
                container, stream, fps, tracker, update, args.box, start_frame, end_frame, stride, window,
            )
        else:
            frames_out, done, total = track_forward(
                container, stream, fps, tracker, update, args.box, start_frame, end_frame, stride,
            )

        eprint_progress(done, total or done)
        json.dump(
            {"fps": fps, "width": width, "height": height, "frames": frames_out},
            sys.stdout,
            ensure_ascii=False,
        )
        sys.stdout.flush()
    finally:
        container.close()


if __name__ == "__main__":
    main()

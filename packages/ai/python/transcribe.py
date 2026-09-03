# faster-whisper 자막 추출 (C6). stdout: JSON {"segments":[{"text","start","end","words":[{"word","start","end"}]}]}
# 시간 단위: 초(float). 초→ms 변환·병합은 노드(@kitkat/ai) 쪽 책임.
import argparse
import json
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description="faster-whisper transcription -> JSON on stdout")
    parser.add_argument("media", help="absolute path to media file")
    parser.add_argument("--language", default=None, help="language code (default: auto-detect)")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster_whisper is not installed (run ensurePython)", file=sys.stderr)
        sys.exit(3)

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    model = WhisperModel("small", device="cpu", compute_type="int8")
    segments, _info = model.transcribe(
        args.media,
        language=args.language,
        vad_filter=True,
        word_timestamps=True,
    )

    out = []
    for seg in segments:
        words = [
            {"word": w.word, "start": w.start, "end": w.end}
            for w in (seg.words or [])
        ]
        out.append({"text": seg.text, "start": seg.start, "end": seg.end, "words": words})

    json.dump({"segments": out}, sys.stdout, ensure_ascii=False)
    sys.stdout.flush()


if __name__ == "__main__":
    main()

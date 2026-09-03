import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  deriveMedia,
  detectEncoder,
  extractAudio,
  gifToWebm,
  interpolateFps,
  makeProxy,
  makeThumb,
  makeWaveform,
  parseCubeLut,
  preprocessReverse,
  probeAsset,
  toGif,
  upscaleVideo,
  waveformBucketMs,
  type WaveformData,
} from '../src/index.js';
import { ffprobeJson } from '../src/ffmpeg.js';

const T = 120_000; // 실 ffmpeg 실행 타임아웃
const T5 = 300_000; // W5 파생·보간 등 무거운 실행 타임아웃

let srcDir: string; // lavfi 로 생성한 소스
let mediaDir: string; // 산출물 media 디렉터리
let vidWithAudio: string; // 3초 testsrc2 + sine
let vidSilent: string; // 3초 testsrc2 (오디오 스트림 없음)
let wav2s: string; // 2초 sine wav
let png: string;
let vidLong: string; // 12초 — 역재생 멀티 청크(5+5+2) 경로 검증용
let webmNoDur: string; // duration 헤더 없는 webm (MediaRecorder 산출물 재현 — 파이프 먹싱)

beforeAll(async () => {
  srcDir = await mkdtemp(path.join(tmpdir(), 'kitkat-media-src-'));
  mediaDir = await mkdtemp(path.join(tmpdir(), 'kitkat-media-out-'));
  vidWithAudio = path.join(srcDir, 'a.mp4');
  vidSilent = path.join(srcDir, 'silent.mp4');
  wav2s = path.join(srcDir, 'tone.wav');
  png = path.join(srcDir, 'pic.png');
  vidLong = path.join(srcDir, 'long.mp4');

  await execa('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest',
    vidWithAudio,
  ]);
  await execa('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an',
    vidSilent,
  ]);
  await execa('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    wav2s,
  ]);
  await execa('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240',
    '-frames:v', '1',
    png,
  ]);
  await execa('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest',
    vidLong,
  ]);
  // 파이프로 먹싱하면 muxer가 되감아 duration을 쓸 수 없다 → MediaRecorder webm과 같은 헤더 없는 파일
  webmNoDur = path.join(srcDir, 'nodur.webm');
  const piped = await execa(
    'ffmpeg',
    ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libopus', '-f', 'webm', '-'],
    { encoding: 'buffer' },
  );
  await writeFile(webmNoDur, Buffer.from(piped.stdout));
}, T);

afterAll(async () => {
  await rm(srcDir, { recursive: true, force: true });
  await rm(mediaDir, { recursive: true, force: true });
});

describe('probeAsset', () => {
  it('오디오 있는 비디오', async () => {
    const p = await probeAsset(vidWithAudio);
    expect(p.kind).toBe('video');
    expect(p.hasAudio).toBe(true);
    expect(p.width).toBe(640);
    expect(p.height).toBe(360);
    expect(p.duration).toBeGreaterThanOrEqual(2800);
    expect(p.duration).toBeLessThanOrEqual(3200);
  }, T);

  it('무음 비디오는 hasAudio=false', async () => {
    const p = await probeAsset(vidSilent);
    expect(p.kind).toBe('video');
    expect(p.hasAudio).toBe(false);
  }, T);

  it('wav 는 kind audio', async () => {
    const p = await probeAsset(wav2s);
    expect(p.kind).toBe('audio');
    expect(p.hasAudio).toBe(true);
    expect(p.duration).toBeGreaterThanOrEqual(1900);
    expect(p.duration).toBeLessThanOrEqual(2100);
  }, T);

  it('png 는 kind image', async () => {
    const p = await probeAsset(png);
    expect(p.kind).toBe('image');
    expect(p.width).toBe(320);
    expect(p.height).toBe(240);
  }, T);

  it('duration 헤더 없는 webm(MediaRecorder류)도 길이를 실측해 채운다', async () => {
    const p = await probeAsset(webmNoDur);
    expect(p.kind).toBe('audio');
    expect(p.duration).toBeGreaterThanOrEqual(1900);
    expect(p.duration).toBeLessThanOrEqual(2100);
  }, T);
});

describe('detectEncoder', () => {
  it('둘 중 하나를 반환하고 캐시된다', async () => {
    const a = await detectEncoder();
    expect(['h264_qsv', 'libx264']).toContain(a);
    const b = await detectEncoder();
    expect(b).toBe(a);
  }, T);
});

describe('makeProxy', () => {
  it('높이 540 프록시를 forward slash 상대경로로 만든다 (이름에 판 표시 .g15)', async () => {
    const rel = await makeProxy(vidWithAudio, mediaDir, 'pxy1');
    expect(rel).toBe('proxies/pxy1.g15.mp4');
    expect(rel.includes('\\')).toBe(false);
    const p = await probeAsset(path.join(mediaDir, rel));
    expect(p.kind).toBe('video');
    expect(p.height).toBe(540);
    expect(p.width).toBe(960); // 640x360 → -2:540
    expect(p.hasAudio).toBe(true);
  }, T);

  // F14 — 스크럽이 빨라지는 이유가 이 키프레임 간격이다. 없으면 기본값(약 250프레임)으로
  // 돌아가 프리뷰가 다시 느려지므로 여기서 못 박는다.
  it('키프레임을 0.5초마다 넣는다 (-g 15)', async () => {
    const rel = await makeProxy(vidWithAudio, mediaDir, 'pxy2');
    const abs = path.join(mediaDir, rel);
    const { stdout } = await execa('ffprobe', [
      '-v', 'error', '-select_streams', 'v',
      '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', abs,
    ]);
    const flags = stdout.trim().split('\n');
    const keys = flags.filter((f) => f.startsWith('1')).length;
    // 소스가 몇 초이든 «프레임 15장마다 한 장» 이면 키프레임이 전체의 1/15 쯤 된다.
    expect(keys).toBeGreaterThanOrEqual(Math.floor(flags.length / 15));
  }, T);
});

describe('makeWaveform', () => {
  const readWave = async (rel: string) =>
    JSON.parse(await readFile(path.join(mediaDir, rel), 'utf8')) as WaveformData;

  it('20ms 버킷 + peaks/rms 객체를 만든다 (W8 F12 — 옛 1000버킷 배열이 아니다)', async () => {
    const rel = await makeWaveform(vidWithAudio, mediaDir, 'wf1');
    expect(rel).toBe('waveforms/wf1.json');
    const w = await readWave(rel!);
    expect(Array.isArray(w)).toBe(false);
    expect(w.bucketMs).toBe(20);
    // 3초 소스 → 20ms 버킷이면 약 150개 (1000 고정이 아니다)
    expect(w.peaks.length).toBeGreaterThan(140);
    expect(w.peaks.length).toBeLessThan(160);
    expect(w.rms.length).toBe(w.peaks.length);
    for (const v of [...w.peaks, ...w.rms]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // lavfi sine 진폭은 1/8 — 소리가 실제로 잡혔는지
    expect(Math.max(...w.peaks)).toBeGreaterThan(0.03);
    // RMS 는 언제나 peak 이하다 (사인파면 peak/√2 근처)
    for (let i = 0; i < w.peaks.length; i++) expect(w.rms[i]!).toBeLessThanOrEqual(w.peaks[i]! + 1e-9);
  }, T);

  it('wav 도 동작한다 — 길이에 비례해 버킷이 늘어난다', async () => {
    const rel = await makeWaveform(wav2s, mediaDir, 'wf2');
    expect(rel).toBe('waveforms/wf2.json');
    const w = await readWave(rel!);
    expect(w.bucketMs).toBe(20);
    expect(w.peaks.length).toBeGreaterThan(90);   // 2초 / 20ms ≈ 100
    expect(w.peaks.length).toBeLessThan(110);
    expect(Math.max(...w.peaks)).toBeGreaterThan(0.03);
  }, T);

  it('오디오 없는 비디오는 null', async () => {
    const rel = await makeWaveform(vidSilent, mediaDir, 'wf3');
    expect(rel).toBeNull();
  }, T);

  it('아주 긴 소스는 버킷 시간을 늘려 개수를 묶는다 (20000버킷 상한)', () => {
    expect(waveformBucketMs(60_000)).toBe(20);        // 60초 → 3000버킷
    expect(waveformBucketMs(400_000)).toBe(20);       // 400초 = 상한 정확히
    expect(waveformBucketMs(600_000)).toBe(30);       // 10분 → 20000버킷
    expect(waveformBucketMs(3_600_000)).toBe(180);    // 1시간
  });

  it('100ms 짜리 음절 하나를 검출한다 (옛 60ms 버킷에서는 놓칠 수 있었다)', async () => {
    // 3초 무음 안에 1.0초부터 100ms 만 소리가 있는 파일
    const blip = path.join(srcDir, 'blip.wav');
    await execa('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'sine=f=440:d=0.1:r=44100',
      '-af', 'adelay=1000,apad=whole_dur=3',
      '-c:a', 'pcm_s16le', blip,
    ]);
    const rel = await makeWaveform(blip, mediaDir, 'wf4');
    const w = await readWave(rel!);
    const loud = w.rms
      .map((v, i) => ({ v, ms: i * w.bucketMs }))
      .filter((b) => b.v > 0.01);
    expect(loud.length).toBeGreaterThanOrEqual(4);   // 100ms / 20ms = 5버킷 안팎
    expect(loud.length).toBeLessThanOrEqual(7);
    expect(loud[0]!.ms).toBeGreaterThanOrEqual(980);
    expect(loud[loud.length - 1]!.ms).toBeLessThanOrEqual(1120);
  }, T);
});

describe('makeThumb', () => {
  it('가로 320 jpg 썸네일을 만든다', async () => {
    const rel = await makeThumb(vidWithAudio, mediaDir, 'th1');
    expect(rel).toBe('thumbs/th1.jpg');
    const abs = path.join(mediaDir, rel);
    expect((await stat(abs)).size).toBeGreaterThan(0);
    const p = await probeAsset(abs);
    expect(p.kind).toBe('image');
    expect(p.width).toBe(320);
  }, T);

  it('이미지 입력도 동작한다', async () => {
    const rel = await makeThumb(png, mediaDir, 'th2');
    expect((await stat(path.join(mediaDir, rel))).size).toBeGreaterThan(0);
  }, T);
});

describe('preprocessReverse', () => {
  it('3초 영상: duration ±100ms', async () => {
    const rel = await preprocessReverse(vidWithAudio, mediaDir, 'rv1');
    expect(rel).toBe('derived/rv1.rev.mp4');
    const p = await probeAsset(path.join(mediaDir, rel));
    expect(p.kind).toBe('video');
    expect(p.hasAudio).toBe(true);
    expect(Math.abs((p.duration ?? 0) - 3000)).toBeLessThanOrEqual(100);
  }, T);

  it('12초 영상(멀티 청크 5+5+2): duration 근사 유지', async () => {
    const rel = await preprocessReverse(vidLong, mediaDir, 'rv2');
    const p = await probeAsset(path.join(mediaDir, rel));
    // 청크별 aac 재인코딩 priming 누적을 감안한 허용 오차
    expect(Math.abs((p.duration ?? 0) - 12000)).toBeLessThanOrEqual(300);
  }, T);
});

describe('extractAudio', () => {
  it('16kHz mono wav 를 추출한다', async () => {
    const out = path.join(mediaDir, 'ex1.wav');
    await extractAudio(vidWithAudio, out);
    const p = await probeAsset(out);
    expect(p.kind).toBe('audio');
    expect(p.duration).toBeGreaterThanOrEqual(2800);
    expect(p.duration).toBeLessThanOrEqual(3200);
  }, T);
});

describe('toGif', () => {
  it('palettegen 2패스로 gif 를 만든다', async () => {
    const out = path.join(mediaDir, 'g1.gif');
    await toGif(vidWithAudio, out, { fps: 10, width: 240 });
    expect((await stat(out)).size).toBeGreaterThan(0);
    const p = await probeAsset(out);
    expect(p.width).toBe(240);
  }, T);
});

// ── W5 확장 ──────────────────────────────────────────────────────────────

/** 항등 3D LUT .cube 텍스트 (red 최속 변화 순서). */
function identityCube(size: number): string {
  const n = size - 1;
  const lines = [`LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        lines.push(`${(r / n).toFixed(6)} ${(g / n).toFixed(6)} ${(b / n).toFixed(6)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

describe('parseCubeLut', () => {
  it('항등 .cube 를 파싱해 size 를 돌려준다', async () => {
    const abs = path.join(srcDir, 'id8.cube');
    await writeFile(abs, identityCube(8));
    expect(await parseCubeLut(abs)).toEqual({ size: 8 });
  }, T);

  it('데이터 줄 수가 N^3 이 아니면 throw', async () => {
    const abs = path.join(srcDir, 'bad-count.cube');
    await writeFile(abs, identityCube(4).split('\n').slice(0, -3).join('\n'));
    await expect(parseCubeLut(abs)).rejects.toThrow('데이터 줄 수 불일치');
  }, T);

  it('LUT_3D_SIZE 가 없으면 throw', async () => {
    const abs = path.join(srcDir, 'no-size.cube');
    await writeFile(abs, '0.0 0.0 0.0\n1.0 1.0 1.0\n');
    await expect(parseCubeLut(abs)).rejects.toThrow('LUT_3D_SIZE');
  }, T);
});

describe('deriveMedia', () => {
  let cubeAbs: string;

  beforeAll(async () => {
    cubeAbs = path.join(srcDir, 'identity.cube');
    await writeFile(cubeAbs, identityCube(8));
  });

  it('LUT(강도 1) → mp4 + 540p 프록시, forward slash 상대경로', async () => {
    const progress: number[] = [];
    const r = await deriveMedia(vidWithAudio, mediaDir, 'da1', 's1111aaaa', {
      lut: { cubeAbs, intensity: 1 },
    }, { onProgress: (p) => progress.push(p) });
    expect(r.src).toBe('derived/da1.s1111aaaa.mp4');
    expect(r.proxySrc).toBe('derived/da1.s1111aaaa.p.g15.mp4'); // 리뷰 #3 — 파생 프록시도 판 표시
    expect(r.src.includes('\\')).toBe(false);
    const p = await probeAsset(path.join(mediaDir, r.src));
    expect(p.kind).toBe('video');
    expect(p.hasAudio).toBe(true);
    expect(Math.abs((p.duration ?? 0) - 3000)).toBeLessThanOrEqual(150);
    // 진행률: 0..1 범위에서 실제로 통지되고 마지막은 1
    expect(progress.length).toBeGreaterThan(0);
    expect(Math.min(...progress)).toBeGreaterThanOrEqual(0);
    expect(progress[progress.length - 1]).toBe(1);
  }, T5);

  it('프록시는 높이 540', async () => {
    const p = await probeAsset(path.join(mediaDir, 'derived/da1.s1111aaaa.p.g15.mp4'));
    expect(p.kind).toBe('video');
    expect(p.height).toBe(540);
  }, T5);

  it('LUT 강도 0.5(blend 경로) — 오디오 없는 소스도 -map 0:a? 로 통과', async () => {
    const r = await deriveMedia(vidSilent, mediaDir, 'da2', 's2222bbbb', {
      lut: { cubeAbs, intensity: 0.5 },
    });
    const p = await probeAsset(path.join(mediaDir, r.src));
    expect(p.kind).toBe('video');
    expect(p.hasAudio).toBe(false);
    expect(Math.abs((p.duration ?? 0) - 3000)).toBeLessThanOrEqual(150);
  }, T5);

  it('denoise → 비디오·오디오 유지, duration ±150ms', async () => {
    const r = await deriveMedia(vidWithAudio, mediaDir, 'da3', 's3333cccc', {
      denoise: { amount: 0.5 },
    });
    const p = await probeAsset(path.join(mediaDir, r.src));
    expect(p.kind).toBe('video');
    expect(p.hasAudio).toBe(true);
    expect(Math.abs((p.duration ?? 0) - 3000)).toBeLessThanOrEqual(150);
  }, T5);

  it('pitch → duration ±150ms', async () => {
    const r = await deriveMedia(vidWithAudio, mediaDir, 'da4', 's4444dddd', {
      pitch: { semitones: 3 },
    });
    const p = await probeAsset(path.join(mediaDir, r.src));
    expect(p.kind).toBe('video');
    expect(p.hasAudio).toBe(true);
    expect(Math.abs((p.duration ?? 0) - 3000)).toBeLessThanOrEqual(150);
  }, T5);

  it('stabilize(vidstab 2패스) → duration ±150ms', async () => {
    const r = await deriveMedia(vidWithAudio, mediaDir, 'da5', 's5555eeee', {
      stabilize: { smoothing: 10 },
    });
    const p = await probeAsset(path.join(mediaDir, r.src));
    expect(p.kind).toBe('video');
    expect(p.hasAudio).toBe(true);
    expect(Math.abs((p.duration ?? 0) - 3000)).toBeLessThanOrEqual(150);
    const pp = await probeAsset(path.join(mediaDir, r.proxySrc!));
    expect(pp.height).toBe(540);
  }, T5);

  it('audioOnly: denoise+pitch → m4a, 프록시 없음', async () => {
    const r = await deriveMedia(wav2s, mediaDir, 'da6', 's6666ffff', {
      denoise: { amount: 0.3 },
      pitch: { semitones: -2 },
    }, { audioOnly: true });
    expect(r.src).toBe('derived/da6.s6666ffff.m4a');
    expect(r.proxySrc).toBeUndefined();
    const p = await probeAsset(path.join(mediaDir, r.src));
    expect(p.kind).toBe('audio');
    expect(Math.abs((p.duration ?? 0) - 2000)).toBeLessThanOrEqual(150);
  }, T5);

  it('빈 spec 은 throw', async () => {
    await expect(deriveMedia(vidWithAudio, mediaDir, 'da7', 's7777aaaa', {})).rejects.toThrow('빈 파생 스펙');
  }, T);
});

describe('gifToWebm', () => {
  it('vp9 + 알파(yuva420p, alpha_mode=1) webm 을 만든다', async () => {
    const gif = path.join(mediaDir, 'sticker.gif');
    await toGif(vidWithAudio, gif, { fps: 10, width: 160 });
    const out = path.join(mediaDir, 'sticker.webm');
    await gifToWebm(gif, out);
    const info = await ffprobeJson(out);
    const v = (info.streams ?? []).find((s) => s.codec_type === 'video');
    expect(v?.codec_name).toBe('vp9');
    // 네이티브 vp9 디코더는 pix_fmt 를 yuv420p 로 보고하므로 컨테이너의 alpha_mode 태그로 확인
    expect(v?.pix_fmt?.startsWith('yuva') || v?.tags?.alpha_mode === '1').toBe(true);
  }, T5);
});

describe('upscaleVideo', () => {
  it('2배 해상도(640x360 → 1280x720)', async () => {
    const out = path.join(mediaDir, 'up2.mp4');
    const progress: number[] = [];
    // W8 F1: 옵션 객체 API. engine:'lanczos' 는 derive.ts 의 기존 구현 그대로다.
    const res = await upscaleVideo(vidWithAudio, out, {
      scale: 2,
      engine: 'lanczos',
      onProgress: (p) => progress.push(p),
    });
    expect(res.engine).toBe('lanczos');
    const p = await probeAsset(out);
    expect(p.kind).toBe('video');
    expect(p.width).toBe(1280);
    expect(p.height).toBe(720);
    expect(progress.length).toBeGreaterThan(0);
    expect(Math.max(...progress)).toBeLessThanOrEqual(1);
  }, T5);
});

describe('interpolateFps', () => {
  it('minterpolate 로 fps 60 을 만든다', async () => {
    const small = path.join(srcDir, 'small.mp4');
    await execa('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an',
      small,
    ]);
    const out = path.join(mediaDir, 'fps60.mp4');
    const res = await interpolateFps(small, out, { fps: 60, engine: 'minterpolate' });
    expect(res.engine).toBe('minterpolate');
    const info = await ffprobeJson(out);
    const v = (info.streams ?? []).find((s) => s.codec_type === 'video');
    expect(v?.avg_frame_rate).toBe('60/1');
    const p = await probeAsset(out);
    expect(Math.abs((p.duration ?? 0) - 3000)).toBeLessThanOrEqual(150);
  }, T5);
});

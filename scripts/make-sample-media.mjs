#!/usr/bin/env node
// media/samples/ 에 데모용 샘플 미디어 4개를 ffmpeg lavfi로 생성한다.
//   clipA.mp4     5초 testsrc2 1080x1920 + 440Hz 사인 톤
//   clipB.mp4     5초 smptebars 1080x1920 + 색상(hue) 회전 + 660Hz 톤
//   bgm.wav       12초 220+440Hz 화음
//   narration.wav 4초 880Hz 톤
import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const samplesDir = path.join(root, 'media', 'samples');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 종료 코드 ${code}: ffmpeg ${args.join(' ')}`));
    });
  });
}

async function main() {
  await mkdir(samplesDir, { recursive: true });

  const clipA = path.join(samplesDir, 'clipA.mp4');
  await run([
    '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=5',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', clipA,
  ]);

  const clipB = path.join(samplesDir, 'clipB.mp4');
  await run([
    '-f', 'lavfi', '-i', 'smptebars=size=1080x1920:rate=30:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:duration=5',
    '-vf', 'hue=H=2*PI*t/5',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', clipB,
  ]);

  const bgm = path.join(samplesDir, 'bgm.wav');
  await run([
    '-f', 'lavfi', '-i', 'aevalsrc=0.35*sin(220*2*PI*t)+0.35*sin(440*2*PI*t):s=44100:d=12',
    '-c:a', 'pcm_s16le', bgm,
  ]);

  const narration = path.join(samplesDir, 'narration.wav');
  await run([
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=4',
    '-c:a', 'pcm_s16le', narration,
  ]);

  for (const f of [clipA, clipB, bgm, narration]) {
    const s = await stat(f);
    if (s.size === 0) throw new Error(`생성 실패(크기 0): ${f}`);
    console.log(`생성됨: ${f.replaceAll('\\', '/')} (${s.size} bytes)`);
  }
}

main().catch((err) => {
  console.error('샘플 미디어 생성 실패:', err.message);
  process.exit(1);
});

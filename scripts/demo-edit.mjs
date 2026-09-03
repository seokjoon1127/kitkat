#!/usr/bin/env node
// C3 HTTP API만 사용하는(fetch) 데모 편집 스크립트. 서버(포트 5757)가 떠 있어야 한다.
// 프로젝트 생성 → 샘플 에셋 3개 임포트 → 클립 배치 → 렌더 → job 폴링 → 결과 경로 출력.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.KITKAT_URL ?? 'http://127.0.0.1:5757';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const samplesDir = path.join(root, 'media', 'samples');

const newId = () => randomUUID().replaceAll('-', '').slice(0, 21);
const abs = (name) => path.join(samplesDir, name).replaceAll('\\', '/');

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  // 1. 프로젝트 생성
  const { doc } = await api('POST', '/api/projects', {
    name: '데모 편집', width: 1080, height: 1920, fps: 30,
  });
  console.log(`프로젝트 생성: ${doc.id}`);

  // 2. 에셋 3개 임포트
  const assets = {};
  for (const name of ['clipA.mp4', 'clipB.mp4', 'bgm.wav']) {
    const { asset } = await api('POST', `/api/projects/${doc.id}/assets`, { path: abs(name) });
    assets[name] = asset;
    console.log(`에셋 임포트: ${name} → ${asset.id}`);
  }

  const videoTrack = doc.tracks.find((t) => t.kind === 'video');
  const textTrack = doc.tracks.find((t) => t.kind === 'text');
  const audioTrack = doc.tracks.find((t) => t.kind === 'audio');
  if (!videoTrack || !textTrack || !audioTrack) throw new Error('기본 트랙(video/text/audio)이 없음');

  // 3. 클립 배치 — A/B 각 4초(A에 zoomIn 600ms 전환), 제목 텍스트(popIn), bgm(볼륨 0.3, 페이드 500ms)
  const commands = [
    { type: 'addClip', trackId: videoTrack.id, clip: {
      id: newId(), kind: 'video', assetId: assets['clipA.mp4'].id,
      start: 0, duration: 4000, in: 0, out: 4000, speed: 1, volume: 1,
      transitionOut: { type: 'zoomIn', duration: 600 },
    } },
    { type: 'addClip', trackId: videoTrack.id, clip: {
      id: newId(), kind: 'video', assetId: assets['clipB.mp4'].id,
      start: 4000, duration: 4000, in: 0, out: 4000, speed: 1, volume: 1,
    } },
    { type: 'addClip', trackId: textTrack.id, clip: {
      id: newId(), kind: 'text', start: 300, duration: 2500,
      text: '킷캣 데모',
      style: {
        fontFamily: "Pretendard, 'Malgun Gothic', sans-serif",
        fontSize: 96, color: '#ffffff', bold: true, align: 'center',
        strokeColor: '#000000', strokeWidth: 4,
      },
      animationIn: { type: 'popIn', duration: 400 },
    } },
    { type: 'addClip', trackId: audioTrack.id, clip: {
      id: newId(), kind: 'audio', assetId: assets['bgm.wav'].id,
      start: 0, duration: 8000, in: 0, out: 8000, speed: 1,
      volume: 0.3, fadeIn: 500, fadeOut: 500,
    } },
  ];
  const { revision } = await api('POST', `/api/projects/${doc.id}/commands`, { commands });
  console.log(`명령 ${commands.length}건 적용 (revision ${revision})`);

  // 4. 렌더 → job 폴링 (2초 간격, 최대 10분)
  const { jobId } = await api('POST', `/api/projects/${doc.id}/render`, { format: 'mp4' });
  console.log(`렌더 시작: job ${jobId}`);
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    const job = await api('GET', `/api/jobs/${jobId}`);
    if (job.status === 'done') {
      console.log(`렌더 완료: ${job.result.path}`);
      return;
    }
    if (job.status === 'error') throw new Error(`렌더 실패: ${job.error}`);
    if (Date.now() > deadline) throw new Error('렌더 타임아웃(10분)');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().catch((err) => {
  console.error('demo-edit 실패:', err.message);
  process.exit(1);
});

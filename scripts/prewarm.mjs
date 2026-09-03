// 사전 준비: Remotion 렌더용 브라우저 · Whisper venv/모델 · Demucs(보컬 분리) · Real-ESRGAN(업스케일)
// · RIFE(프레임 보간) · 한글 폰트(OFL).
// · 마스크 모션 트래킹(OpenCV TrackerVit).
// 사용: node scripts/prewarm.mjs browser | whisper | demucs | tracker | realesrgan | rife | fonts
const mode = process.argv[2];

if (mode === 'browser') {
  const { ensureBrowser } = await import('@remotion/renderer');
  console.log('Remotion 브라우저 확인/다운로드 중...');
  await ensureBrowser({
    onBrowserDownload: () => ({
      version: null,
      onProgress: (p) => {
        if (p.percent != null && Math.round(p.percent * 100) % 10 === 0)
          process.stdout.write(`\r다운로드 ${Math.round(p.percent * 100)}%`);
      },
    }),
  });
  console.log('\n브라우저 준비 완료');
} else if (mode === 'whisper') {
  const { ensurePython, transcribe } = await import('../packages/ai/dist/index.js');
  console.log('venv/faster-whisper 확인·설치 중...');
  const r = await ensurePython();
  if (!r.ok) {
    console.error('ensurePython 실패:', r.hint);
    process.exit(1);
  }
  console.log('faster-whisper 준비 완료. speech.wav 전사(최초 실행 시 모델 다운로드)...');
  const segs = await transcribe('C:/Users/david/project/kitkat/media/samples/speech.wav', { language: 'en' });
  console.log(`세그먼트 ${segs.length}개`);
  for (const s of segs) console.log(`  [${s.start}ms +${s.duration}ms] ${s.text} (words: ${s.words.length})`);
  if (segs.length === 0 || segs.every((s) => s.words.length === 0)) {
    console.error('전사 결과가 비어 있음 — 실패');
    process.exit(1);
  }
  console.log('whisper 사전 준비 완료');
} else if (mode === 'demucs') {
  // 서버의 /separate 라우트는 설치를 시도하지 않는다(2.5GB 를 기다리면 요청이 타임아웃난다).
  // 설치는 여기서 한 번 해 둔다.
  const { ensureDemucs, isDemucsReady } = await import('../packages/ai/dist/index.js');
  if (await isDemucsReady()) {
    console.log('Demucs 이미 준비됨');
  } else {
    console.log('venv/Demucs 확인·설치 중... (PyTorch 포함 약 2.5GB — 몇 분에서 수십 분)');
    const r = await ensureDemucs();
    if (!r.ok) {
      console.error('Demucs 설치 실패:', r.hint);
      process.exit(1);
    }
    console.log('Demucs 준비 완료');
  }
} else if (mode === 'tracker') {
  // F10 마스크 모션 트래킹 — opencv-python-headless(휠 43.8MB, 설치 후 약 90MB) +
  // TrackerVit 모델 ONNX(0.71MB, Apache-2.0). 서버의 /track 라우트는 설치를 시도하지 않는다.
  //
  // contrib 판(+53.8MB)은 깔지 않는다 — TrackerVit 은 기본 패키지에 있다.
  // numpy 는 «절대 낮추지 않는다» — demucs·faster-whisper 가 같은 venv 를 쓴다.
  const { statfs } = await import('node:fs/promises');
  const { ensureTracker, isTrackerReady, vittrackModelPath, TRACKER_INSTALL_BYTES } = await import(
    '../packages/ai/dist/index.js'
  );

  if (await isTrackerReady()) {
    console.log(`추적 엔진 이미 준비됨 (모델: ${vittrackModelPath()})`);
  } else {
    // 디스크가 모자라면 pip 가 반쯤 설치된 패키지를 남긴다 — 시작 전에 한국어로 막는다.
    try {
      const fs = await statfs(process.cwd());
      const free = fs.bavail * fs.bsize;
      if (free < TRACKER_INSTALL_BYTES * 1.5) {
        console.error(
          `디스크 여유가 부족합니다: ${(free / 1073741824).toFixed(1)}GB 남음, ` +
            `${((TRACKER_INSTALL_BYTES * 1.5) / 1048576).toFixed(0)}MB 필요 (opencv 휠 43.8MB → 설치 후 약 90MB).`,
        );
        process.exit(1);
      }
    } catch {
      // statfs 를 못 쓰는 환경이면 그냥 진행한다 — 실패하면 pip 가 알려 준다.
    }
    console.log('opencv-python-headless 설치 + TrackerVit 모델(0.71MB) 다운로드 중...');
    const r = await ensureTracker();
    if (!r.ok) {
      console.error('추적 엔진 준비 실패:', r.hint);
      process.exit(1);
    }
    console.log(`설치 완료 — 모델: ${vittrackModelPath()}`);
  }

  // 실제로 도는지 확인 — 합성 프레임 2장으로 init/update 한 번.
  const { execa } = await import('execa');
  const path = (await import('node:path')).default;
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const py = path.join(
    root,
    'packages/ai/.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const probe = await execa(
    py,
    [
      '-c',
      [
        'import cv2, numpy as np',
        'p = cv2.TrackerVit.Params()',
        `p.net = r"${vittrackModelPath()}"`,
        't = cv2.TrackerVit.create(p)',
        'a = np.zeros((360,640,3), np.uint8); a[100:200,200:300] = 255',
        'b = np.zeros((360,640,3), np.uint8); b[100:200,210:310] = 255',
        't.init(a, (200,100,100,100))',
        'ok, box = t.update(b)',
        'print("cv2", cv2.__version__, "numpy", np.__version__, "box", box, "score", round(t.getTrackingScore(),3))',
      ].join('\n'),
    ],
    { reject: false },
  );
  if (probe.exitCode !== 0) {
    console.error('추적기 동작 확인 실패:', probe.stderr?.slice(0, 600));
    process.exit(1);
  }
  console.log(probe.stdout.trim());
  console.log('추적 엔진 준비 완료');
} else if (mode === 'realesrgan') {
  // Real-ESRGAN ncnn-vulkan (PyTorch 불필요, GPU 는 Vulkan 으로 잡는다) 을 vendor/realesrgan/ 에 푼다.
  //
  // ⚠️ 이 컴퓨터에서 실제로 문제가 났다 (2026-09-01):
  //    이걸 돌리는 동안 Windows 가 5번 다운됐다. 전부 BugCheck 0x116(VIDEO_TDR_ERROR) —
  //    그래픽 드라이버가 응답을 멈췄고 복구에 실패해 재부팅됐다.
  //    원인으로 의심되는 것: VRAM 2GB · NVIDIA MX450 드라이버가 2020년판(27.21.14.5256).
  //    **그래픽 드라이버를 최신으로 올리기 전에는 쓰지 마라.** 업스케일은 lanczos 경로로도 동작한다.
  console.warn('');
  console.warn('경고: 이 컴퓨터에서 Real-ESRGAN 실행 중 그래픽 드라이버가 죽어 시스템이 5번 재부팅됐다.');
  console.warn('      (BugCheck 0x116 VIDEO_TDR_ERROR — 드라이버가 응답을 멈추고 복구에 실패)');
  console.warn('      그래픽 드라이버를 최신으로 올린 뒤에 쓰는 것을 권한다. 업스케일은 lanczos 로도 동작한다.');
  console.warn('      받기만 하고 실행은 하지 않는다. 5초 안에 Ctrl+C 로 중단할 수 있다.');
  console.warn('');
  await new Promise((r) => setTimeout(r, 5000));
  const { execa } = await import('execa');
  const { mkdir, mkdtemp, readdir, rename, rm, stat } = await import('node:fs/promises');
  const { createWriteStream } = await import('node:fs');
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { fileURLToPath } = await import('node:url');

  const URL_ZIP =
    'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip';
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(root, 'vendor', 'realesrgan');
  const exe = path.join(dir, process.platform === 'win32' ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan');

  if (await stat(exe).then(() => true, () => false)) {
    console.log(`Real-ESRGAN 이미 준비됨: ${exe}`);
  } else {
    if (process.platform !== 'win32') {
      console.error('이 스크립트는 Windows 릴리스만 받습니다. 다른 OS 는 릴리스를 직접 받아 vendor/realesrgan/ 에 푸세요.');
      process.exit(1);
    }
    const tmp = await mkdtemp(path.join(tmpdir(), 'kitkat-resrgan-'));
    try {
      console.log(`다운로드 중: ${URL_ZIP}`);
      const res = await fetch(URL_ZIP);
      if (!res.ok || !res.body) throw new Error(`다운로드 실패 (HTTP ${res.status})`);
      const zip = path.join(tmp, 'realesrgan.zip');
      await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
      console.log(`받음: ${((await stat(zip)).size / 1048576).toFixed(2)}MB — 압축 해제 중...`);

      const unpack = path.join(tmp, 'unpack');
      await mkdir(unpack, { recursive: true });
      // zip 해제는 System32 의 bsdtar 로 — PATH 의 `tar` 는 Git 의 GNU tar 일 수 있고
      // 그건 `C:\…` 를 원격 호스트로 읽어서 실패한다(zip 도 못 푼다).
      const bsdtar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      await execa(bsdtar, ['-xf', zip, '-C', unpack]);

      // 릴리스에 따라 최상위가 파일이거나 폴더 하나 — exe 가 있는 디렉터리를 찾는다
      const entries = await readdir(unpack, { withFileTypes: true });
      let srcDir = unpack;
      if (!entries.some((e) => e.isFile() && e.name.startsWith('realesrgan-ncnn-vulkan'))) {
        const sub = entries.find((e) => e.isDirectory());
        if (!sub) throw new Error('압축 파일에서 실행 파일을 찾지 못했습니다');
        srcDir = path.join(unpack, sub.name);
      }
      await mkdir(path.dirname(dir), { recursive: true });
      await rm(dir, { recursive: true, force: true });
      await rename(srcDir, dir);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    console.log(`설치 완료: ${dir}`);
  }

  // 실제로 도는지(그리고 GPU 를 잡는지) 확인
  const probe = await execa(exe, ['-h'], { reject: false });
  const help = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  if (!/-n model-name/.test(help)) {
    console.error('실행 파일이 응답하지 않습니다:', help.slice(0, 400));
    process.exit(1);
  }
  const models = await readdir(path.join(dir, 'models')).catch(() => []);
  console.log(`모델 ${models.filter((f) => f.endsWith('.param')).length}종: ${models.join(', ')}`);
  console.log('Real-ESRGAN 준비 완료');
} else if (mode === 'rife') {
  // RIFE ncnn-vulkan (프레임 보간). realesrgan 과 같은 저자·같은 ncnn 백엔드·같은 CLI 형태 —
  // PyTorch 불필요, GPU 는 Vulkan 으로 잡는다. vendor/rife/ 에 푼다.
  //
  // ⚠️ realesrgan 과 같은 경고: 이 컴퓨터에서 2026-09-01 에 GPU 처리 중 Windows 가 5번 다운됐다.
  console.warn('');
  console.warn('경고: 이 컴퓨터에서 ncnn-vulkan 처리 중 그래픽 드라이버가 죽어 시스템이 5번 재부팅됐다.');
  console.warn('      (BugCheck 0x116 VIDEO_TDR_ERROR — 드라이버가 응답을 멈추고 복구에 실패)');
  console.warn('      NVIDIA MX450 드라이버가 2020년판이다. 실행은 드라이버가 최근인 GPU 로만 하거나');
  console.warn('      CPU(-g -1)로 해라. 여기서는 받기만 하고 -h 응답만 확인한다(처리 없음).');
  console.warn('      5초 안에 Ctrl+C 로 중단할 수 있다.');
  console.warn('');
  await new Promise((r) => setTimeout(r, 5000));
  const { execa } = await import('execa');
  const { mkdir, mkdtemp, readdir, rename, rm, stat } = await import('node:fs/promises');
  const { createWriteStream } = await import('node:fs');
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { fileURLToPath } = await import('node:url');

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(root, 'vendor', 'rife');
  const exe = path.join(dir, process.platform === 'win32' ? 'rife-ncnn-vulkan.exe' : 'rife-ncnn-vulkan');

  if (await stat(exe).then(() => true, () => false)) {
    console.log(`RIFE 이미 준비됨: ${exe}`);
  } else {
    if (process.platform !== 'win32') {
      console.error('이 스크립트는 Windows 릴리스만 받습니다. 다른 OS 는 릴리스를 직접 받아 vendor/rife/ 에 푸세요.');
      process.exit(1);
    }
    // 릴리스 URL 을 고정하지 않고 최신 릴리스를 API 로 조회한다(태그가 바뀌면 하드코딩은 404 가 된다).
    console.log('최신 릴리스 조회 중: nihui/rife-ncnn-vulkan');
    const relRes = await fetch('https://api.github.com/repos/nihui/rife-ncnn-vulkan/releases/latest', {
      headers: { 'User-Agent': 'kitkat-prewarm', Accept: 'application/vnd.github+json' },
    });
    if (!relRes.ok) throw new Error(`릴리스 조회 실패 (HTTP ${relRes.status})`);
    const rel = await relRes.json();
    const asset = (rel.assets ?? []).find((a) => /windows.*\.zip$/i.test(a.name));
    if (!asset) throw new Error(`릴리스 ${rel.tag_name} 에 windows zip 이 없습니다`);
    console.log(`릴리스 ${rel.tag_name} — ${asset.name} (${(asset.size / 1048576).toFixed(1)}MB)`);

    const tmp = await mkdtemp(path.join(tmpdir(), 'kitkat-rife-'));
    try {
      console.log(`다운로드 중: ${asset.browser_download_url}`);
      const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'kitkat-prewarm' } });
      if (!res.ok || !res.body) throw new Error(`다운로드 실패 (HTTP ${res.status})`);
      const zip = path.join(tmp, 'rife.zip');
      await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
      console.log(`받음: ${((await stat(zip)).size / 1048576).toFixed(2)}MB — 압축 해제 중...`);

      const unpack = path.join(tmp, 'unpack');
      await mkdir(unpack, { recursive: true });
      // zip 해제는 System32 의 bsdtar 로 — PATH 의 `tar` 는 Git 의 GNU tar 일 수 있고
      // 그건 `C:\…` 를 원격 호스트로 읽어서 실패한다(zip 도 못 푼다).
      const bsdtar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      await execa(bsdtar, ['-xf', zip, '-C', unpack]);

      // 릴리스에 따라 최상위가 파일이거나 폴더 하나 — exe 가 있는 디렉터리를 찾는다
      const entries = await readdir(unpack, { withFileTypes: true });
      let srcDir = unpack;
      if (!entries.some((e) => e.isFile() && e.name.startsWith('rife-ncnn-vulkan'))) {
        const sub = entries.find((e) => e.isDirectory());
        if (!sub) throw new Error('압축 파일에서 실행 파일을 찾지 못했습니다');
        srcDir = path.join(unpack, sub.name);
      }
      await mkdir(path.dirname(dir), { recursive: true });
      await rm(dir, { recursive: true, force: true });
      await rename(srcDir, dir);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    console.log(`설치 완료: ${dir}`);
  }

  // 실제로 도는지 확인 — -h 만. 실제 보간은 여기서 하지 않는다(GPU 사고 이력).
  const probe = await execa(exe, ['-h'], { reject: false });
  const help = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  if (!/-m model-path/.test(help)) {
    console.error('실행 파일이 응답하지 않습니다:', help.slice(0, 400));
    process.exit(1);
  }
  console.log('--- rife -h ---');
  console.log(help.trim());
  console.log('---------------');
  // 모델은 최상위 폴더로 들어 있다(realesrgan 처럼 models/ 아래가 아니다)
  const dirents = await readdir(dir, { withFileTypes: true });
  const modelDirs = [];
  for (const e of dirents) {
    if (!e.isDirectory()) continue;
    const inner = await readdir(path.join(dir, e.name)).catch(() => []);
    if (inner.some((f) => f.endsWith('.param'))) modelDirs.push(e.name);
  }
  console.log(`모델 ${modelDirs.length}종: ${modelDirs.join(', ')}`);
  console.log('RIFE 준비 완료 (실제 보간은 실행하지 않았다)');
} else if (mode === 'fonts') {
  // 자막용 한글 폰트(전부 OFL)를 구글 폰트 공식 저장소에서 media/fonts/ 로 받는다.
  // OFL 은 라이선스 동봉을 요구하므로 각 폰트의 OFL.txt 도 media/fonts/licenses/ 에 받는다.
  const { mkdir, stat, writeFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const { fileURLToPath } = await import('node:url');

  // [slug, 저장소 파일명, 저장 파일명] — 저장 파일명은 URL 에 안전한 이름으로만 쓴다
  const FONT_FILES = [
    ['notosanskr', 'NotoSansKR[wght].ttf', 'NotoSansKR-VF.ttf'],
    ['gothica1', 'GothicA1-Regular.ttf', 'GothicA1-Regular.ttf'],
    ['gothica1', 'GothicA1-Black.ttf', 'GothicA1-Black.ttf'],
    ['blackhansans', 'BlackHanSans-Regular.ttf', 'BlackHanSans-Regular.ttf'],
    ['dohyeon', 'DoHyeon-Regular.ttf', 'DoHyeon-Regular.ttf'],
    ['jua', 'Jua-Regular.ttf', 'Jua-Regular.ttf'],
    ['gaegu', 'Gaegu-Regular.ttf', 'Gaegu-Regular.ttf'],
    ['gaegu', 'Gaegu-Bold.ttf', 'Gaegu-Bold.ttf'],
    ['nanumpenscript', 'NanumPenScript-Regular.ttf', 'NanumPenScript-Regular.ttf'],
    ['songmyung', 'SongMyung-Regular.ttf', 'SongMyung-Regular.ttf'],
    ['nanummyeongjo', 'NanumMyeongjo-Regular.ttf', 'NanumMyeongjo-Regular.ttf'],
    ['nanummyeongjo', 'NanumMyeongjo-ExtraBold.ttf', 'NanumMyeongjo-ExtraBold.ttf'],
  ];

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fontsDir = path.join(root, 'media', 'fonts');
  const licDir = path.join(fontsDir, 'licenses');
  await mkdir(licDir, { recursive: true });

  const RAW = 'https://github.com/google/fonts/raw/main/ofl';
  const exists = (p) => stat(p).then((s) => s.size > 0, () => false);

  /** 받아서 저장. 이미 있으면 건너뛴다. 404 등은 throw. */
  const fetchTo = async (url, dest, label) => {
    if (await exists(dest)) {
      const { size } = await stat(dest);
      console.log(`  건너뜀 ${label} (이미 있음, ${(size / 1024).toFixed(0)}KB)`);
      return;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status} — ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    console.log(`  받음 ${label} ${(buf.length / 1024).toFixed(0)}KB`);
  };

  const slugs = [...new Set(FONT_FILES.map(([slug]) => slug))];
  console.log(`폰트 ${FONT_FILES.length}개 · 라이선스 ${slugs.length}개 확인 중 → ${fontsDir}`);
  for (const [slug, remote, local] of FONT_FILES) {
    await fetchTo(`${RAW}/${slug}/${encodeURIComponent(remote)}`, path.join(fontsDir, local), local);
  }
  for (const slug of slugs) {
    await fetchTo(`${RAW}/${slug}/OFL.txt`, path.join(licDir, `${slug}-OFL.txt`), `${slug}-OFL.txt`);
  }

  // ── drawStroke(획 그리기)의 «윤곽선 전용» 정적 인스턴스 (W8 F8 #8) ──
  // NotoSansKR-VF.ttf 는 fvar 기본 인스턴스가 wght=100(Thin)이라 glyf 만 읽으면 Thin 윤곽선이 나온다.
  // 화면 글자는 그대로 VF(@font-face)를 쓰고, 획의 경로만 이 정적 파일에서 뽑는다.
  // 구글 폰트 저장소(github ofl/notosanskr)에는 VF 만 있고 정적 인스턴스는 **다운로드 목록(manifest)**
  // 에만 있다 — 같은 v39 릴리스, 같은 OFL(라이선스는 위의 notosanskr-OFL.txt 가 곧 그것이다).
  // gstatic URL 은 해시라 고정하지 않고 목록에서 읽는다.
  const STATIC = [
    ['static/NotoSansKR-Regular.ttf', 'NotoSansKR-Regular.ttf'],
    ['static/NotoSansKR-Bold.ttf', 'NotoSansKR-Bold.ttf'],
  ];
  const missing = [];
  for (const [, local] of STATIC) if (!(await exists(path.join(fontsDir, local)))) missing.push(local);
  if (missing.length === 0) {
    for (const [, local] of STATIC) console.log(`  건너뜀 ${local} (이미 있음)`);
  } else {
    const LIST = 'https://fonts.google.com/download/list?family=Noto%20Sans%20KR';
    const res = await fetch(LIST);
    if (!res.ok) throw new Error(`정적 폰트 목록: HTTP ${res.status} — ${LIST}`);
    // 응답 앞의 `)]}'` 는 JSON 하이재킹 방지 접두어다 — 떼고 파싱한다
    const manifest = JSON.parse((await res.text()).replace(/^\)\]\}'\s*/, ''));
    const refs = manifest?.manifest?.fileRefs ?? [];
    for (const [remote, local] of STATIC) {
      const ref = refs.find((r) => r.filename === remote);
      if (!ref) throw new Error(`정적 폰트 목록에 ${remote} 가 없습니다 (구글 폰트 배포가 바뀌었는지 확인)`);
      await fetchTo(ref.url, path.join(fontsDir, local), `${local} (윤곽선용, ${remote})`);
    }
  }
  console.log('폰트 준비 완료');
} else if (mode === 'voice-ir' || mode === 'ir') {
  // F11 공간감(리버브)용 임펄스 응답을 vendor/ir/voxengo/ 에 푼다.
  //
  // Voxengo IM Reverbs 를 쓰는 이유 (2026-09-02 직접 확인):
  //   · OpenAIR(york.ac.uk) 은 **죽었다**(Account Suspended)
  //   · EchoThief·MIT IR Survey 는 **라이선스 문구가 없거나 출처마다 엇갈린다** → 안 쓴다
  //   · Voxengo 는 라이선스에 "royalty-free for any purpose, including commercial usage" 가 명시돼 있다
  //
  // ⚠️ 같은 라이선스에 **「이 파일 자체를 팔거나 배포로 수익을 내는 것 금지」** 조항이 있다.
  //    도구로 쓰는 것은 무방하지만 **kitkat 을 «판매» 할 계획이 생기면 반드시 다시 확인해야 한다.**
  //    그래서 리포에 넣지 않고(vendor/ 는 .gitignore) 받는 사람이 라이선스를 같이 갖게 한다.
  const { mkdir, readdir, rename, rm, stat, writeFile } = await import('node:fs/promises');
  const { execa } = await import('execa');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { fileURLToPath } = await import('node:url');

  const URL_ZIP = 'https://www.voxengo.com/files/impulses/IMreverbs.zip';
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(root, 'vendor', 'ir', 'voxengo');
  await mkdir(dir, { recursive: true });

  const already = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.wav'));
  if (already.length > 0 && process.argv[3] !== '--force') {
    console.log(`IR ${already.length}개가 이미 있습니다 → ${dir}  (다시 받으려면 --force)`);
    process.exit(0);
  }

  /** 파일명 → irId 슬러그. UI 의 VOICE_IR_OPTIONS 와 «같은 규칙» 이어야 한다. */
  const slugify = (name) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  const tmp = await mkdtemp(path.join(tmpdir(), 'kitkat-ir-'));
  try {
    console.log(`Voxengo IM Reverbs 내려받는 중... (${URL_ZIP})`);
    const res = await fetch(URL_ZIP);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${URL_ZIP}`);
    const zip = Buffer.from(await res.arrayBuffer());
    const zipPath = path.join(tmp, 'ir.zip');
    await writeFile(zipPath, zip);
    console.log(`  받음 ${(zip.length / 1024 / 1024).toFixed(1)}MB — 푸는 중`);

    // zip 해제는 System32 의 bsdtar 로 — PATH 의 `tar` 는 Git 의 GNU tar 일 수 있고
    // 그건 `C:\...` 를 «원격 호스트» 로 읽어 "Cannot connect to C:" 로 죽는다 (실제로 겪었다).
    const bsdtar =
      process.platform === 'win32'
        ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
    await execa(bsdtar, ['-xf', zipPath, '-C', tmp]);

    let wavs = 0;
    let license = false;
    for (const entry of await readdir(tmp)) {
      const abs = path.join(tmp, entry);
      if ((await stat(abs)).isDirectory()) continue;
      if (entry.toLowerCase().endsWith('.wav')) {
        await rename(abs, path.join(dir, `${slugify(entry.replace(/\.wav$/i, ''))}.wav`));
        wavs++;
      } else if (/license|readme/i.test(entry)) {
        // 라이선스는 **반드시** 같이 둔다 — 배포 조건 4a 가 「사본에 저작권 고지를 붙일 것」이다
        await rename(abs, path.join(dir, 'LICENSE.txt'));
        license = true;
      }
    }
    if (wavs === 0) throw new Error('압축 안에 wav 가 없습니다 — 배포본이 바뀌었는지 확인하세요');
    if (!license) throw new Error('라이선스 파일이 없습니다 — 라이선스 없이는 설치하지 않습니다');
    console.log(`IR ${wavs}개 + 라이선스 준비 완료 → ${dir}`);
    console.log('  라이선스: 상업적 사용 무료 / **파일 자체의 판매·배포 수익은 금지**');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
} else {
  console.error(
    '사용법: node scripts/prewarm.mjs browser|whisper|demucs|tracker|realesrgan|rife|fonts|voice-ir',
  );
  process.exit(1);
}

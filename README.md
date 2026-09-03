# kitkat — 에이전트용 로컬 영상 편집기

쇼츠·광고를 만드는 **에이전트가 API로 조종**하고, **사람은 브라우저에서 직접 편집**하는 로컬 영상 편집 서버입니다.
CapCut의 핵심 기능(컷 편집·전환·효과·자막·자동자막)을 전부 이 컴퓨터 안에서 처리합니다 — 클라우드·외부 API 없음.

## 빠른 시작

```bash
npm install        # 최초 1회
npm run build      # 전 패키지 빌드
npm start          # 서버 기동 → http://localhost:5757
```

프로젝트를 만들고 편집기를 열려면:

```bash
curl -X POST http://localhost:5757/api/projects -H "content-type: application/json" -d "{\"name\":\"내 쇼츠\"}"
# 응답의 doc.id를 브라우저로: http://localhost:5757/p/<id>
```

전체 흐름을 한 번에 보는 데모(샘플 생성 → 편집 → 렌더):

```bash
npm run samples    # media/samples/ 에 테스트 소스 생성
npm run demo       # 서버가 켜져 있어야 함 — 8초 쇼츠를 조립해 mp4 렌더
```

확장 기능(LUT·손떨림·속도 커브·정지화면·비트·더킹·알파 MOV 등)을 한 번에 훑는 데모:

```bash
node scripts/demo-w5.mjs           # 빠른 것 전부 (20단계)
node scripts/demo-w5.mjs --full    # 업스케일·프레임 보간·보컬 분리까지
```

## 에이전트 연결

**HTTP API** — 베이스 `http://127.0.0.1:5757`. 계약 전문은 `docs/superpowers/plans/2026-09-01-kitkat-v1.md`의 C3 표.
핵심: `POST /api/projects` → `POST /api/projects/:id/commands`(편집 명령 배치) → `POST /api/projects/:id/render` → `GET /api/jobs/:jobId`.

**MCP** (Claude Code 등 MCP 지원 에이전트):

```bash
claude mcp add kitkat -- node C:\Users\david\project\kitkat\packages\mcp\dist\index.js
```

도구 19종: `kitkat_create_project` · `kitkat_list_projects` · `kitkat_get_project` · `kitkat_apply_commands` ·
`kitkat_import_asset` · `kitkat_extract_audio` · `kitkat_render` · `kitkat_get_job` · `kitkat_auto_caption` ·
`kitkat_detect_beats` · `kitkat_separate_stems` · `kitkat_upscale` · `kitkat_interpolate_fps` · `kitkat_render_cover` ·
`kitkat_match_color` · `kitkat_track_mask` · `kitkat_scopes` · `kitkat_capabilities` · `kitkat_editor_url`
자세한 사용법: `packages/mcp/README.md`

에이전트가 "이 서버가 뭘 할 수 있는지"를 하드코딩하지 않으려면 `kitkat_capabilities`
(= `GET /api/capabilities`)를 부르면 됩니다 — 전환·효과·텍스트 템플릿·속도 프리셋 목록에 더해
**`effectCatalog`(갈래·파라미터 범위)** 와 **`pendingEffects`(걸어도 아무 일도 안 일어나므로 고르면 안 되는 효과)**,
**`loudnessTargets`(내보낼 곳별 목표 라우드니스)** 까지 돌려줍니다.

에이전트가 편집한 내용은 열려 있는 편집기 화면에 **실시간 반영**되고(WebSocket), 사람이 화면에서 고친 것도 에이전트가 다음 호출 때 그대로 봅니다 — 둘 다 같은 JSON 프로젝트 문서 하나를 편집합니다.

## 기능

- **컷 편집**: 자르기/분할/트림/이동/복제, 멀티트랙(영상·오버레이·텍스트·오디오), 배속 0.1~100×(음정 보존), 역재생, 스냅, **정지화면**, **커브 속도**(프리셋 6종 — 몽타주·총알 시간 등, 소리 유지)
- **화면**: 위치/크기/회전/반전/크롭 **+ 색·블러·효과 파라미터까지 전부** 키프레임 애니메이션
  (이징 **프리셋 12종 + 직접 그리는 베지어 곡선 + 스프링**), 오버레이+블렌드 모드 11종,
  마스크(사각/원/선형/**자유 곡선 펜 툴**, 페더, **여러 장 겹치기**, **모션 트래킹으로 대상 따라가기**),
  **크로마키(색차 기반 + 물듦 제거 — 영상·이미지 둘 다)**, 배경 채우기(단색/블러/이미지), **스티커/GIF 반복**
- **전환 51종**(기본·슬라이드 12·와이프 11·줌 6·회전 5·충격 9·휩팬 3 — 슬라이드·줌·휩팬에는
  이동 방향으로 번지는 블러가 자동으로 걸린다) · **화면 효과 50종**(기본색 10·룩 10·흐림 9·질감 9·왜곡 7·스타일 5).
  SVG 필터로는 못 그리는 6종(vibrance·bokeh·radialBlur·mirror·kaleidoscope·halftone)은 **WebGL 로 그립니다** —
  최종 렌더(Remotion `createEffect`)와 빠른 미리보기가 **같은 셰이더 문자열**을 쓰고, 픽셀 대조 6/6 평균 0.00·최대 ≤1.
  (bokeh 는 원반 커널 2D 표본이라 소프트웨어 GPU 에선 느립니다 — 1080p 약 14초/프레임.)
- **모션 블러**: **소스 영상**(ffmpeg 프레임 보간 — 영상 «속» 피사체가 흐려진다) · **트랜스폼**(켄번스 줌·글자 이동 등 합성 단계의 움직임, 셔터 각도로 조절)
- **색 보정**: **색조정 커브**(RGB/R/G/B 채널별) · **LUT**(.cube 임포트 + 강도) ·
  **컷별 색 맞추기**(기준 컷의 채널 통계로 다른 컷을 맞춘다 — 맞추기 «전/후» 색차를 숫자로 보여준다) ·
  **HSL 세컨더리**(빨강·노랑·초록·청록·파랑·자홍 계열별, 「피부 밝게」·「하늘 진하게」 프리셋 + 스포이드) ·
  **스코프**(파형·벡터스코프·히스토그램 — 실시간 WebGL 판과 최종 렌더 기준 정밀 판)
- **영상 보정**: **손떨림 보정**(vidstab) · **업스케일 2×/3×/4×**(AI **Real-ESRGAN** 또는 ffmpeg lanczos) ·
  **프레임 보간 48/60/120fps**(AI **RIFE** 또는 ffmpeg minterpolate)
- **텍스트**: **번들 한글 폰트 9종**(Noto Sans KR·Black Han Sans·Do Hyeon·Jua·Gaegu·Nanum Pen Script·Song Myung·Nanum Myeongjo·Gothic A1 — 전부 OFL),
  외곽선·그림자·배경, **등장/퇴장 애니 21종 × 단위 4종(전체·줄·단어·글자) + 시차(stagger)** —
  타자기·단어 하이라이트·**획이 그려지는 붓글씨**까지. **템플릿 90종**(기본·예능·광고·감성·손글씨·뉴스·숫자·미니멀·키네틱)
- **오디오**: 볼륨·페이드·트랙 볼륨, 파형 표시, 보이스오버 녹음, 영상에서 소리 추출,
  **비트 감지 + 비트 스냅**, **더킹**(키프레임 근사 또는 **진짜 사이드체인 컴프** — 목표 감쇠에 앉을 때까지 재서 고친다),
  **나레이션 오디오 체인**(잡음 제거 → 디에서 → EQ → 컴프 → 리미터 → 피치 → **2패스 라우드니스 정규화**,
  공간감 IR 리버브), **보컬 분리**(Demucs)
- **자동자막**: Whisper(로컬 CPU) — 단어별 타이밍 포함, 노래방식 하이라이트
- **내보내기**: MP4(H.264) / GIF / **MOV(ProRes 4444, 배경 투명)**, 해상도·fps·구간 지정, **커버(대표 이미지) 지정**,
  **목표 라우드니스 프리셋**(유튜브·소셜 −14 / **구글 광고 납품 −24 LKFS(공식 규격)** / 스포티파이 −14 / 애플 팟캐스트 −16 / 넷플릭스 −27)
- **편집기**: 다크 3패널 UI, 미리보기는 최종 렌더와 동일한 코드(WYSIWYG), 540p 프록시(0.5초마다 키프레임)로 부드럽게,
  **빠른 미리보기**는 WebCodecs 로 디코드해 WebGL 로 합성한다. 실행취소/다시하기, 단축키(Space/S/F/Delete/Ctrl+D/Ctrl+Z…)
  — WebCodecs 디코드는 **워커에서** 돈다(메인 스레드가 합성·타임라인을 그리느라 디코더를 굶기던 것을 고쳤다).
  **실제 편집기 화면에서 한 프레임씩 끌 때 «맞는 프레임이 없는 화면»: `<video>` 경로 90~100% → WebCodecs 2.5~5%**
  (3회, 소프트웨어 GPU 기준). 임의 지점 점프는 두 경로를 같이 띄워 먼저 오는 쪽을 그린다.

## 알아둘 것

- **자막 폰트는 `media/fonts/` 에 들어 있습니다**(OFL 한글 9종, 약 35MB). 없으면 시스템 폰트로
  폴백되며 렌더는 정상 동작합니다. 다시 받으려면: `node scripts/prewarm.mjs fonts`
- **AI 업스케일·프레임 보간은 그래픽카드를 골라서 씁니다.** 이 컴퓨터에는 GPU 가 둘인데
  NVIDIA MX450 은 드라이버가 2020년판이라 그걸로 돌리면 시스템이 죽습니다
  (실제로 5번 재부팅됐습니다 — BugCheck 0x116 VIDEO_TDR_ERROR). 그래서 kitkat 은 드라이버 날짜를 보고
  **인텔 Iris Xe(2025년 드라이버)를 고릅니다.** 단계별로 시험해 확인했습니다 —
  512px 2.25초 · 1080×1920 4.64초 · 2초 영상 36.3초, **새 사고 0건**.
  엔진이 없으면 자동으로 ffmpeg(lanczos / minterpolate)로 물러섭니다.
  미리 받으려면: `node scripts/prewarm.mjs realesrgan` · `rife`
- 자동자막 최초 실행 시 파이썬 환경과 모델(~500MB)을 자동 설치합니다. 미리 준비하려면: `node scripts/prewarm.mjs whisper`
- 첫 렌더 전에 렌더용 브라우저를 자동 다운로드합니다. 미리 준비하려면: `node scripts/prewarm.mjs browser`
- **보컬 분리는 Demucs(PyTorch, ~2.5GB)를 최초 1회 설치**합니다. 설치가 안 돼 있으면 API가 501을 돌려주고 이유를 알려줍니다.
- 이 머신(GPU 2GB, NVENC 없음)에서는 인코딩이 CPU로 돌아갑니다 — 30초 쇼츠 기준 수 분.
- **편집용 프록시(540p 사본)는 판이 바뀌면 이름에 표시가 붙습니다**(`.g15.mp4` — 키프레임을 0.5초마다).
  옛 판 프록시를 가진 프로젝트를 열면 미디어 패널에 **「옛 프록시 N개 갱신」** 버튼이 뜹니다 — 누르면 원본·파생
  가리지 않고 한 잡으로 전부 다시 굽습니다(파생은 본체를 다시 굽지 않고 540p 사본만). 자동으로는 돌지 않습니다.
- **API 로 없는 필드를 넣으면 400 으로 거절합니다** — 오타(`chromaKeyy`)든, 그 클립 종류가 지원하지 않는 설정이든
  «조용히 저장되고 아무 일도 안 일어나는» 대신 `스키마에 없는 필드: tracks.0.clips.0.chromaKeyy` 처럼 경로를 말합니다.
  저장된 프로젝트에 이미 그런 필드가 얼마나 있는지는 `node scripts/scan-unknown-fields.mjs` 로 셀 수 있습니다.
- **잡이 시간 초과되면 그 잡이 띄운 프로세스(ffmpeg·업스케일·파이썬)도 같이 종료됩니다.** 큐만 넘어가고 프로세스가
  남는 일은 없습니다.
- **LUT·손떨림·잡음·피치는 "구워서" 씁니다.** 클립에 이 설정을 걸면 서버가 그 클립 전용 파일을
  ffmpeg으로 만들고, 미리보기와 최종 렌더가 **같은 파일**을 씁니다(색이 갈리지 않게). 굽는 동안에는
  원본이 그대로 보이고, 끝나면 자동으로 바뀝니다.
- **속도 커브가 걸린 클립은 분할·트림이 안 됩니다.** 먼저 속도 커브를 해제하세요.
- **마스크 모션 트래킹은 OpenCV(TrackerVit)** 를 씁니다. 최초 1회 설치가 필요합니다:
  `node scripts/prewarm.mjs tracker` (약 90MB). 이 컴퓨터 실측 **720p 4.46ms/프레임** —
  30초 영상을 4초에 훑습니다. **추적을 놓친 구간은 키프레임을 넣지 않고 「여기서 놓쳤습니다」로 알려줍니다.**
- **"빠른 미리보기(실험)"** 토글은 WebCodecs+WebGL 합성 미리보기입니다. 기본은 꺼져 있고,
  Remotion 미리보기가 결과물과 일치하는 기준입니다. 마스크·글로우·샤픈·색수차·그레인·스캔라인·
  라이트리크·글리치 전환·정확한 블러를 **이제 전부 그립니다** — 최종 렌더와의 픽셀 차이는
  **평균 0.00~0.14**(그레인만 평균 3.99 — 노이즈 무늬가 달라서 픽셀은 달라도 세기는 같습니다).
  배지는 「못 그림」이 아니라 **「최종 렌더와 이만큼 다릅니다」로 실측 숫자**를 띄웁니다.

## 구조

```
packages/schema    프로젝트 문서(JSON 타임라인) 타입·검증 — 모든 것의 심장
packages/engine    편집 명령 23종 적용 (서버·UI 공용 → 기능 패리티)
packages/media     FFmpeg 처리 (프록시·파형·썸네일·역재생·GIF·파생 미디어·비트 감지·업스케일·보간)
packages/renderer  Remotion 컴포지션 + 렌더 (미리보기와 최종 렌더가 같은 코드)
packages/server    HTTP API + WebSocket 동기화 + 작업 큐 (포트 5757)
packages/mcp       MCP 서버 (HTTP API 래퍼)
packages/ui        브라우저 편집기 (React, 타임라인·인스펙터·플레이어·WebGL 빠른 미리보기)
packages/ai        자동자막(faster-whisper) + 보컬 분리(Demucs), 로컬 CPU
```

설계 결정 전체: `PRD.md`
구현 계획: `docs/superpowers/plans/2026-09-01-kitkat-v1.md`(v1) · `2026-09-01-kitkat-w5.md`(W5 확장)

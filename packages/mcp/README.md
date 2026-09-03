# @kitkat/mcp

kitkat 로컬 영상 편집 서버를 에이전트가 부릴 수 있게 하는 MCP(stdio) 서버.
모든 도구는 kitkat HTTP API(`KITKAT_URL`, 기본 `http://127.0.0.1:5757`)를 호출한다.

## 준비

1. 빌드: `npm run build -w @kitkat/mcp`
2. kitkat 서버 기동: `npm run start -w @kitkat/server` (포트 5757)
   — 서버가 꺼져 있어도 MCP 서버 자체는 뜨고 도구 목록도 나오지만, 도구 호출은 연결 오류를 돌려준다.

## Claude Code 등록

```sh
claude mcp add kitkat -- node <절대경로>/packages/mcp/dist/index.js
```

예 (Windows):

```sh
claude mcp add kitkat -- node C:/Users/david/project/kitkat/packages/mcp/dist/index.js
```

다른 주소의 서버를 쓰려면 환경변수를 얹는다:

```sh
claude mcp add kitkat -e KITKAT_URL=http://127.0.0.1:5757 -- node <절대경로>/packages/mcp/dist/index.js
```

## 도구 16종

| 도구 | 하는 일 |
|---|---|
| `kitkat_create_project` | 프로젝트 생성 (`name`, `width?`, `height?`, `fps?`) |
| `kitkat_list_projects` | 프로젝트 목록 `{id, name, revision}[]` |
| `kitkat_get_project` | 프로젝트 문서(doc) 전체 조회 |
| `kitkat_apply_commands` | 편집 명령 배치 적용 (C2 Command 19종, `baseRevision?`) |
| `kitkat_import_asset` | 로컬 절대경로 파일을 에셋으로 임포트 (+후처리 jobId) |
| `kitkat_extract_audio` | 비디오 에셋에서 오디오(wav) 추출 → 새 audio 에셋 |
| `kitkat_render` | mp4/gif/mov 렌더 잡 시작 → `{jobId}` (`mov`는 알파 MOV, `transparent?`) |
| `kitkat_get_job` | 잡 상태 조회. `wait: true`면 완료까지 2초 폴링(최대 10분) |
| `kitkat_auto_caption` | Whisper 자동자막 잡 시작 → `{jobId}` |
| `kitkat_detect_beats` | 오디오 에셋 비트 감지 잡 시작 → `{jobId}`, 완료 시 `asset.beats` 기록 |
| `kitkat_separate_stems` | 보컬/반주 분리 잡 시작 → `{jobId}`, 완료 시 audio 에셋 2개 추가 (Demucs 없으면 501) |
| `kitkat_upscale` | 비디오 업스케일(`scale?: 2\|4`) 잡 시작 → `{jobId}`, 완료 시 새 video 에셋 |
| `kitkat_interpolate_fps` | 프레임 보간(`fps?`) 잡 시작 → `{jobId}`, 완료 시 새 video 에셋 |
| `kitkat_render_cover` | 커버(대표 이미지 jpg) 렌더 잡 시작 (`timeMs?`) → `{jobId}`, `result.url`이 이미지 |
| `kitkat_capabilities` | 지원 전환·효과·텍스트 템플릿·속도 램프 프리셋 등 목록 조회 |
| `kitkat_editor_url` | 사람용 편집기 URL (`http://localhost:5757/p/<id>`) |

잡을 돌려주는 도구는 전부 `kitkat_get_job` (`wait: true`) 로 완료를 확인한다.

## 전형적인 흐름

1. `kitkat_create_project` → doc.id 확보
2. `kitkat_import_asset` (절대경로) → asset.id 확보
3. `kitkat_apply_commands` 로 클립 배치·자르기·자막 스타일 등 편집
4. `kitkat_render` → `kitkat_get_job` (`wait: true`) → `result.url`
5. 사람 손질이 필요하면 `kitkat_editor_url` 을 열어 준다

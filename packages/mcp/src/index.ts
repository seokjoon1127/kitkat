#!/usr/bin/env node
// @kitkat/mcp — kitkat 서버(C3 HTTP API)를 부리는 MCP stdio 서버. 도구 16종(C5 + X7).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.KITKAT_URL ?? 'http://127.0.0.1:5757').replace(/\/+$/, '');
const EDITOR_BASE = process.env.KITKAT_URL
  ? BASE
  : 'http://localhost:5757';

class HttpError extends Error {}

async function http(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new HttpError(
      `kitkat 서버(${BASE})에 연결하지 못했습니다: ${e instanceof Error ? e.message : String(e)}. ` +
        `서버가 켜져 있는지, KITKAT_URL이 맞는지 확인하세요.`,
    );
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const detail = typeof json === 'string' ? json : JSON.stringify(json);
    throw new HttpError(`HTTP ${res.status} ${method} ${path}: ${detail}`);
  }
  return json;
}

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
  };
}

function tool<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Job = { id: string; status: 'queued' | 'running' | 'done' | 'error' } & Record<string, unknown>;

async function getJob(jobId: string, wait: boolean): Promise<unknown> {
  if (!wait) return http('GET', `/api/jobs/${encodeURIComponent(jobId)}`);
  const deadline = Date.now() + 10 * 60 * 1000; // 최대 10분
  for (;;) {
    const job = (await http('GET', `/api/jobs/${encodeURIComponent(jobId)}`)) as Job;
    if (job.status === 'done' || job.status === 'error') return job;
    if (Date.now() >= deadline) {
      throw new HttpError(`잡 ${jobId} 이(가) 10분 안에 끝나지 않았습니다 (마지막 상태: ${JSON.stringify(job)})`);
    }
    await sleep(2000); // 2초 폴링
  }
}

const server = new McpServer({ name: 'kitkat', version: '0.1.0' });

server.registerTool(
  'kitkat_create_project',
  {
    description: '새 kitkat 프로젝트를 만든다. 기본 1080x1920 30fps. 결과로 프로젝트 문서(doc)를 반환.',
    inputSchema: {
      name: z.string().describe('프로젝트 이름'),
      width: z.number().int().positive().optional().describe('캔버스 너비(px), 기본 1080'),
      height: z.number().int().positive().optional().describe('캔버스 높이(px), 기본 1920'),
      fps: z.number().positive().optional().describe('초당 프레임, 기본 30'),
    },
  },
  tool(async ({ name, width, height, fps }) => ok(await http('POST', '/api/projects', { name, width, height, fps }))),
);

server.registerTool(
  'kitkat_list_projects',
  {
    description: '프로젝트 목록을 가져온다. 각 항목은 {id, name, revision}.',
    inputSchema: {},
  },
  tool(async () => ok(await http('GET', '/api/projects'))),
);

server.registerTool(
  'kitkat_get_project',
  {
    description: '프로젝트 문서(doc) 전체를 가져온다 (assets, tracks, clips 포함).',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
    },
  },
  tool(async ({ projectId }) => ok(await http('GET', `/api/projects/${encodeURIComponent(projectId)}`))),
);

server.registerTool(
  'kitkat_apply_commands',
  {
    description:
      '편집 명령 배치를 원자적으로 적용한다 (C2 Command 19종: addClip, splitClip, trimClip, moveClip, updateClip, setClipSpeed, setKeyframes 등). ' +
      'baseRevision을 주면 그 리비전 기준으로만 적용(불일치 시 409 에러에 현재 doc 포함).',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
      commands: z.array(z.record(z.unknown())).describe('Command 객체 배열 (각각 type 필드 필수)'),
      baseRevision: z.number().int().optional().describe('낙관적 동시성 검사용 기준 revision'),
    },
  },
  tool(async ({ projectId, commands, baseRevision }) =>
    ok(await http('POST', `/api/projects/${encodeURIComponent(projectId)}/commands`, { commands, baseRevision })),
  ),
);

server.registerTool(
  'kitkat_import_asset',
  {
    description:
      '로컬 파일(절대경로)을 프로젝트 에셋으로 가져온다. 즉시 asset이 추가되고, 프록시/파형/썸네일은 백그라운드 잡(jobId)으로 처리된다.',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
      path: z.string().describe('가져올 미디어 파일의 로컬 절대경로'),
    },
  },
  tool(async ({ projectId, path }) => ok(await http('POST', `/api/projects/${encodeURIComponent(projectId)}/assets`, { path }))),
);

server.registerTool(
  'kitkat_extract_audio',
  {
    description: '비디오 에셋에서 오디오를 wav로 추출해 새 audio 에셋으로 추가한다.',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
      assetId: z.string().describe('오디오를 추출할 비디오 에셋 id'),
    },
  },
  tool(async ({ projectId, assetId }) =>
    ok(
      await http(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/extract-audio`,
      ),
    ),
  ),
);

server.registerTool(
  'kitkat_render',
  {
    description:
      '프로젝트를 렌더링한다(mp4/gif/mov). jobId를 반환하며, wait:true면 잡이 끝날 때까지 기다려 최종 잡 상태를 반환한다 (kitkat_get_job(wait:true)와 동일 폴링).',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
      range: z
        .object({ start: z.number(), end: z.number() })
        .optional()
        .describe('렌더 구간(타임라인 ms). 생략하면 전체'),
      proxy: z.boolean().optional().describe('true면 프록시 소스로 빠른 렌더'),
      format: z.enum(['mp4', 'gif', 'mov']).optional().describe("출력 포맷, 기본 'mp4'. 'mov'는 알파(투명 배경) MOV 내보내기"),
      transparent: z.boolean().optional().describe("배경을 투명하게 렌더 (format 'mov'면 기본 true)"),
      width: z.number().int().positive().optional().describe('출력 너비 오버라이드'),
      height: z.number().int().positive().optional().describe('출력 높이 오버라이드'),
      fps: z.number().positive().optional().describe('출력 fps 오버라이드'),
      outName: z.string().optional().describe('출력 파일 이름'),
      wait: z.boolean().optional().describe('true면 렌더 잡 완료까지 기다린다 (2초 폴링, 최대 10분)'),
    },
  },
  tool(async ({ projectId, range, proxy, format, transparent, width, height, fps, outName, wait }) => {
    const res = (await http('POST', `/api/projects/${encodeURIComponent(projectId)}/render`, {
      range,
      proxy,
      format,
      transparent,
      width,
      height,
      fps,
      outName,
    })) as { jobId: string };
    if (wait !== true) return ok(res);
    const job = (await getJob(res.jobId, true)) as Job;
    if (job.status === 'error') return fail(new HttpError(`렌더 잡 실패: ${JSON.stringify(job)}`));
    return ok(job);
  }),
);

server.registerTool(
  'kitkat_get_job',
  {
    description:
      '잡 상태를 조회한다 {id, type, status, progress, result?, error?}. wait:true면 완료(done/error)까지 2초 간격으로 최대 10분 폴링.',
    inputSchema: {
      jobId: z.string().describe('잡 id'),
      wait: z.boolean().optional().describe('true면 잡이 끝날 때까지 기다린다 (최대 10분)'),
    },
  },
  tool(async ({ jobId, wait }) => ok(await getJob(jobId, wait === true))),
);

server.registerTool(
  'kitkat_auto_caption',
  {
    description:
      '오디오/비디오 에셋을 Whisper로 받아써서 자동자막(TextClip)을 text 트랙에 추가하는 잡을 시작한다. jobId 반환.',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
      assetId: z.string().describe('받아쓸 오디오/비디오 에셋 id'),
      trackId: z.string().optional().describe('자막을 넣을 text 트랙 id (생략 시 기본 text 트랙)'),
      style: z.record(z.unknown()).optional().describe('TextStyle 부분 오버라이드'),
      language: z.string().optional().describe("언어 힌트 (예: 'ko', 'en')"),
    },
  },
  tool(async ({ projectId, assetId, trackId, style, language }) =>
    ok(
      await http('POST', `/api/projects/${encodeURIComponent(projectId)}/captions`, {
        assetId,
        trackId,
        style,
        language,
      }),
    ),
  ),
);

server.registerTool(
  'kitkat_detect_beats',
  {
    description:
      '오디오 에셋의 박자(비트) 위치를 찾아 문서(asset.beats)에 기록하는 잡을 시작한다. 컷 타이밍을 음악에 맞출 때 쓴다. jobId 반환 — 완료는 kitkat_get_job(wait:true)으로 확인.',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
      assetId: z.string().describe('비트를 감지할 오디오 에셋 id'),
    },
  },
  tool(async ({ projectId, assetId }) =>
    ok(
      await http(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/beats`,
      ),
    ),
  ),
);

server.registerTool(
  'kitkat_separate_stems',
  {
    description:
      '오디오 에셋을 보컬/반주 2개의 새 audio 에셋으로 분리하는 잡을 시작한다(Demucs). 목소리만 쓰거나 반주만 깔 때 쓴다. Demucs가 없으면 501 에러. jobId 반환 — 완료는 kitkat_get_job(wait:true)으로 확인.',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
      assetId: z.string().describe('분리할 오디오 에셋 id'),
    },
  },
  tool(async ({ projectId, assetId }) =>
    ok(
      await http(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/separate`,
      ),
    ),
  ),
);

server.registerTool(
  'kitkat_upscale',
  {
    description:
      '비디오 에셋을 2배/4배 업스케일한 새 video 에셋을 만드는 잡을 시작한다. 저해상도 소스를 캔버스 해상도에 맞출 때 쓴다. jobId 반환 — 완료는 kitkat_get_job(wait:true)으로 확인.',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
      assetId: z.string().describe('업스케일할 비디오 에셋 id'),
      scale: z.union([z.literal(2), z.literal(4)]).optional().describe('배율 2 또는 4, 기본 2'),
    },
  },
  tool(async ({ projectId, assetId, scale }) =>
    ok(
      await http(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/upscale`,
        { scale },
      ),
    ),
  ),
);

server.registerTool(
  'kitkat_interpolate_fps',
  {
    description:
      '움직임 보상 프레임 보간으로 fps를 높인 새 video 에셋을 만드는 잡을 시작한다. 끊기는 영상을 부드럽게 하거나 슬로모션 소스를 만들 때 쓴다. jobId 반환 — 완료는 kitkat_get_job(wait:true)으로 확인.',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
      assetId: z.string().describe('프레임 보간할 비디오 에셋 id'),
      fps: z.number().positive().optional().describe('목표 fps (예: 60)'),
    },
  },
  tool(async ({ projectId, assetId, fps }) =>
    ok(
      await http(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/interpolate`,
        { fps },
      ),
    ),
  ),
);

server.registerTool(
  'kitkat_render_cover',
  {
    description:
      '타임라인의 한 시점(timeMs)을 커버(대표 이미지 jpg)로 렌더하는 잡을 시작하고 settings.coverMs에 기록한다. 썸네일이 필요할 때 쓴다. jobId 반환 — 완료는 kitkat_get_job(wait:true)으로 확인, result.url이 이미지 경로.',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
      timeMs: z.number().optional().describe('커버로 쓸 타임라인 시각(ms). 생략 시 서버 기본'),
    },
  },
  tool(async ({ projectId, timeMs }) =>
    ok(await http('POST', `/api/projects/${encodeURIComponent(projectId)}/cover`, { timeMs })),
  ),
);

// ── W8 — 서버에는 있는데 MCP 에 없던 것들 (에이전트가 쓸 수 없으면 만든 의미가 없다) ──

server.registerTool(
  'kitkat_match_color',
  {
    description:
      '한 컷의 색을 다른 컷에 «맞춘다» — 기준 클립의 채널별 평균·표준편차를 재서 대상 클립에 아핀 사상으로 옮긴다. 여러 소스를 이어 붙인 광고에서 컷마다 색온도·밝기가 튀는 것을 없앨 때 쓴다. 결과에 맞추기 «전/후» 색차(deltaBefore·deltaAfter)가 들어 있어 실제로 가까워졌는지 숫자로 확인할 수 있다. 이미 잰 값이 유효하면 다시 재지 않는다(measured:false).',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
      clipId: z.string().describe('색을 바꿀 대상 비디오 클립 id'),
      refClipId: z.string().describe('기준이 될 클립 id (비디오 또는 이미지). 자기 자신·순환은 거절된다'),
      strength: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('0..1 — 0 이면 원본 그대로, 1 이면 완전히 맞춘다. 기본 1'),
      region: z
        .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
        .optional()
        .describe('대상에서 색을 잴 영역(0..1 비율). 하늘·간판처럼 튀는 부분을 뺄 때'),
      refRegion: z
        .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
        .optional()
        .describe('기준에서 색을 잴 영역(0..1 비율)'),
    },
  },
  tool(async ({ projectId, clipId, refClipId, strength, region, refRegion }) =>
    ok(
      await http(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/clips/${encodeURIComponent(clipId)}/match`,
        { refClipId, strength, region, refRegion },
      ),
    ),
  ),
);

server.registerTool(
  'kitkat_track_mask',
  {
    description:
      '클립의 마스크가 화면 속 대상을 «따라가게» 한다 — 마스크 상자를 시작점으로 물체를 추적해 mask.x/y/w/h 키프레임을 넣는다. 얼굴·상품·번호판을 가리거나 강조할 때 쓴다. **먼저 마스크를 켜고 대상 위에 맞춰야 한다** (그 상자가 시작점이다). 추적을 놓친 구간에는 키프레임을 안 넣고 결과에 구간 목록으로 알려 준다 — 그 지점에서 마스크를 옮기고 startMs 를 줘서 이어 붙이면 된다. 엔진이 없으면 501 (`node scripts/prewarm.mjs tracker` 로 설치). jobId 반환 — 완료는 kitkat_get_job(wait:true).',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
      clipId: z.string().describe('마스크가 켜져 있는 비디오 클립 id'),
      box: z
        .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
        .optional()
        .describe('추적 시작 상자(0..1 비율). 생략하면 지금 마스크 위치를 쓴다'),
      startMs: z.number().optional().describe('클립 시작 기준 몇 ms 부터 추적할지. 기본 0'),
      endMs: z.number().optional().describe('어디까지. 기본 클립 끝'),
      tolerancePx: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('키프레임 간소화 허용 오차(px). 작을수록 키프레임이 많다. 기본 4 — 추적기 자체 오차(평균 3.5px)보다 작은 값'),
    },
  },
  tool(async ({ projectId, clipId, box, startMs, endMs, tolerancePx }) =>
    ok(
      await http(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/clips/${encodeURIComponent(clipId)}/track`,
        { box, startMs, endMs, tolerancePx },
      ),
    ),
  ),
);

server.registerTool(
  'kitkat_scopes',
  {
    description:
      '지정 시각의 최종 화면을 굽고 방송용 «스코프» 그림과 통계를 낸다 — 파형(밝기 분포)·벡터스코프(색상·채도)·히스토그램. 색 보정을 한 뒤 «정말 그렇게 됐는지» 를 눈이 아니라 숫자로 확인할 때 쓴다. 같은 시각·같은 판이면 캐시를 쓴다. jobId 반환 — 완료는 kitkat_get_job(wait:true), 결과에 PNG url 과 통계가 들어 있다.',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
      timeMs: z.number().optional().describe('타임라인 기준 시각(ms). 기본 0'),
      kinds: z
        .array(z.enum(['waveform', 'vectorscope', 'histogram']))
        .optional()
        .describe('필요한 것만 고른다. 기본 셋 다'),
      proxy: z.boolean().optional().describe('true 면 540p 프록시로 빠르게 (색은 같다)'),
    },
  },
  tool(async ({ projectId, timeMs, kinds, proxy }) =>
    ok(await http('POST', `/api/projects/${encodeURIComponent(projectId)}/scopes`, { timeMs, kinds, proxy })),
  ),
);

server.registerTool(
  'kitkat_capabilities',
  {
    description:
      '서버가 지원하는 전환·효과·텍스트 애니메이션·텍스트 템플릿·속도 램프 프리셋·블렌드 모드 목록을 가져온다. 편집 명령을 만들기 전에 쓸 수 있는 값을 확인할 때 쓴다. `effectCatalog`·`transitionCatalog` 에 갈래·파라미터 범위가 들어 있고, **`pendingEffects` 에 있는 효과는 걸어도 화면에 아무 일도 안 일어나므로 고르면 안 된다.** `loudnessTargets` 는 내보낼 곳별 목표 라우드니스인데, 구글 광고 납품은 −24 LKFS 가 공식 규격이고 기본값 −14 는 공식 문서 없는 관행값이다.',
    inputSchema: {},
  },
  tool(async () => ok(await http('GET', '/api/capabilities'))),
);

server.registerTool(
  'kitkat_editor_url',
  {
    description: '사람이 브라우저로 열 수 있는 편집기 URL을 돌려준다.',
    inputSchema: {
      projectId: z.string().describe('프로젝트 id'),
    },
  },
  tool(async ({ projectId }) => ok(`${EDITOR_BASE}/p/${encodeURIComponent(projectId)}`)),
);

const transport = new StdioServerTransport();
await server.connect(transport);

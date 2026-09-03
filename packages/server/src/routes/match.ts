// F4 컷별 색 맞추기 — 측정 라우트 + matchStats 잡 (계획 04).
//
// 굽는 것은 이미 derive.ts 가 한다. 여기서 하는 것은 «기준 컷과 대상 컷의 색 통계를 재서
// source.matchTo.levels 에 넣는 것» 뿐이다. levels 가 들어오면 sourceKey 가 바뀌고
// scheduleDeriveJobs 가 알아서 굽는다 — 이 라우트는 굽기를 직접 부르지 않는다.
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { findClip } from '@kitkat/engine';
import {
  sourceKey,
  type Asset,
  type ChannelStat,
  type Clip,
  type ClipSource,
  type Crop,
  type MatchLevels,
  type ProjectDoc,
  type VideoClip,
} from '@kitkat/schema';
import {
  clippedFraction,
  matchAffine,
  matchColorLevels,
  measureChannelHistograms,
  predictAfter,
  sampleTimesMs,
  statsFromHistogram,
  type ChannelHistogram,
} from '@kitkat/media';
import { sendError, type AppContext } from '../app.js';

/** 측정에 쓸 수 있는 클립 — 화면에 픽셀이 있는 것. */
type PixelClip = Extract<Clip, { kind: 'video' } | { kind: 'image' }>;

export type MatchRequest = {
  refClipId: string;
  strength: number;
  region?: Crop;
  refRegion?: Crop;
};

/** 채널별 «맞추기 전/후» 색차(0..255 단위)와 뭉갠 비율. */
export type MatchReport = {
  sampledAtMs: number[];
  channels: { before: number; after: number }[];
  deltaBefore: number;
  deltaAfter: number;
  /** 감소율 0..1 (deltaBefore 가 0이면 1). W7 실측은 0.94 였다. */
  reduction: number;
  clippedBefore: { low: number; high: number };
  clippedAfter: { low: number; high: number };
};

const isCrop = (v: unknown): v is Crop => {
  if (v == null || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (['x', 'y', 'w', 'h'] as const).every(
    (k) => typeof c[k] === 'number' && Number.isFinite(c[k] as number) && (c[k] as number) >= 0 && (c[k] as number) <= 1,
  );
};

/**
 * 요청 검증 — 엔진이 `matchTo` 를 안 보므로(W8 S3 는 스키마까지만 했다) 여기서 막는다.
 * 문서를 깨는 조합은 잡을 등록하기 «전에» 400 으로 돌려보낸다.
 */
export function validateMatchRequest(
  doc: ProjectDoc,
  clipId: string,
  body: Record<string, unknown>,
): { ok: true; req: MatchRequest; clip: VideoClip; ref: PixelClip } | { ok: false; code: number; error: string } {
  const found = findClip(doc, clipId);
  if (!found) return { ok: false, code: 404, error: `클립 없음: ${clipId}` };
  if (found.clip.kind !== 'video') {
    return { ok: false, code: 400, error: 'BAD_MATCH: 색 맞추기는 비디오 클립에만 걸 수 있습니다' };
  }
  const clip = found.clip;

  const refClipId = body.refClipId;
  if (typeof refClipId !== 'string' || refClipId.length === 0) {
    return { ok: false, code: 400, error: 'refClipId 가 필요합니다' };
  }
  if (refClipId === clipId) {
    return { ok: false, code: 400, error: 'BAD_MATCH: 자기 자신을 기준으로 삼을 수 없습니다' };
  }
  const refFound = findClip(doc, refClipId);
  if (!refFound) return { ok: false, code: 404, error: `기준 클립 없음: ${refClipId}` };
  if (refFound.clip.kind !== 'video' && refFound.clip.kind !== 'image') {
    return { ok: false, code: 400, error: 'BAD_MATCH: 기준 컷은 비디오·이미지 클립이어야 합니다' };
  }
  const ref = refFound.clip;

  // 순환(A→B→A) — 기준을 따라가다 자기 자신이 나오면 굽는 순서가 정해지지 않는다.
  const seen = new Set<string>([clipId]);
  let cursor: string | undefined = refClipId;
  while (cursor) {
    if (seen.has(cursor)) {
      return { ok: false, code: 400, error: 'BAD_MATCH: 기준 컷이 서로를 가리키고 있습니다(순환)' };
    }
    seen.add(cursor);
    const f = findClip(doc, cursor);
    cursor = f && f.clip.kind === 'video' ? f.clip.source?.matchTo?.clipId : undefined;
  }

  let strength = 1;
  if (body.strength !== undefined) {
    if (typeof body.strength !== 'number' || !Number.isFinite(body.strength) || body.strength < 0 || body.strength > 1) {
      return { ok: false, code: 400, error: 'BAD_MATCH: strength 는 0..1 이어야 합니다' };
    }
    strength = body.strength;
  } else {
    strength = clip.source?.matchTo?.strength ?? 1;
  }

  const req: MatchRequest = { refClipId, strength };
  for (const key of ['region', 'refRegion'] as const) {
    const v = body[key] ?? clip.source?.matchTo?.[key];
    if (v === undefined || v === null) continue;
    if (!isCrop(v)) return { ok: false, code: 400, error: `BAD_MATCH: ${key} 은 0..1 사각형이어야 합니다` };
    if (v.w <= 0 || v.h <= 0) {
      return { ok: false, code: 400, error: `BAD_MATCH: ${key} 의 크기가 0입니다 — 0픽셀은 잴 수 없습니다` };
    }
    req[key] = v;
  }
  return { ok: true, req, clip, ref };
}

/** 두 사각형이 같은가 (없음 === 없음). */
function sameCrop(a: Crop | undefined, b: Crop | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** 기준 클립이 지금 보이는 색의 identity — 파생이 있으면 그 키, 없으면 'raw'. */
export function refSourceKeyOf(ref: PixelClip, assets: Record<string, Asset>): string {
  if (ref.kind !== 'video') return 'raw';
  const key = sourceKey(ref);
  if (key === null) return 'raw';
  return assets[ref.assetId]?.derived?.[key] ? key : 'raw';
}

/**
 * 이미 잰 값을 다시 쓸 수 있는가.
 * 기준 컷의 파생 설정이 바뀌면(refSourceKey 불일치) **다시 재야 한다** — 조용히 옛 값을 쓰지 않는다.
 */
export function canReuseLevels(
  existing: ClipSource['matchTo'] | undefined,
  req: MatchRequest,
  refKeyNow: string,
): boolean {
  const l = existing?.levels;
  if (!existing || !l) return false;
  return (
    existing.clipId === req.refClipId &&
    l.refSourceKey === refKeyNow &&
    sameCrop(existing.region, req.region) &&
    sameCrop(existing.refRegion, req.refRegion)
  );
}

/** 클립이 실제로 디코드될 파일 — 역재생 클립은 역재생 파일이 곧 원본이다. */
function bakeSrcOf(clip: PixelClip, asset: Asset): string {
  if (clip.kind === 'video' && clip.reversed === true && asset.reversedSrc) return asset.reversedSrc;
  return asset.src;
}

/** 측정할 시각들 — 이미지는 한 장뿐이다. */
function timesOf(clip: PixelClip): number[] {
  return clip.kind === 'video' ? sampleTimesMs(clip.in, clip.out) : [0];
}

const sum3 = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** 측정된 히스토그램 → levels + 전/후 예측 보고. */
export function buildReport(
  refHist: [ChannelHistogram, ChannelHistogram, ChannelHistogram],
  tgtHist: [ChannelHistogram, ChannelHistogram, ChannelHistogram],
  strength: number,
): { ref: [ChannelStat, ChannelStat, ChannelStat]; target: [ChannelStat, ChannelStat, ChannelStat]; report: Omit<MatchReport, 'sampledAtMs'> } {
  const ref = refHist.map(statsFromHistogram) as [ChannelStat, ChannelStat, ChannelStat];
  const target = tgtHist.map(statsFromHistogram) as [ChannelStat, ChannelStat, ChannelStat];
  const channels: { before: number; after: number }[] = [];
  let clipBeforeLow = 0;
  let clipBeforeHigh = 0;
  let clipAfterLow = 0;
  let clipAfterHigh = 0;
  for (let i = 0; i < 3; i++) {
    const { a, b } = matchAffine(ref[i]!, target[i]!, strength);
    const after = predictAfter(tgtHist[i]!, a, b);
    channels.push({
      before: Math.abs(ref[i]!.mean - target[i]!.mean) * 255,
      after: Math.abs(ref[i]!.mean - after.stat.mean) * 255,
    });
    const cb = clippedFraction(tgtHist[i]!);
    clipBeforeLow = Math.max(clipBeforeLow, cb.low);
    clipBeforeHigh = Math.max(clipBeforeHigh, cb.high);
    clipAfterLow = Math.max(clipAfterLow, after.clipped.low);
    clipAfterHigh = Math.max(clipAfterHigh, after.clipped.high);
  }
  const deltaBefore = sum3(channels.map((c) => c.before));
  const deltaAfter = sum3(channels.map((c) => c.after));
  return {
    ref,
    target,
    report: {
      channels,
      deltaBefore,
      deltaAfter,
      reduction: deltaBefore > 1e-9 ? Math.max(0, 1 - deltaAfter / deltaBefore) : 1,
      clippedBefore: { low: clipBeforeLow, high: clipBeforeHigh },
      clippedAfter: { low: clipAfterLow, high: clipAfterHigh },
    },
  };
}

export function registerMatchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/projects/:id/clips/:clipId/match', async (req, reply) => {
    const { id, clipId } = req.params as { id: string; clipId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const doc = await ctx.store.get(id);
      const v = validateMatchRequest(doc, clipId, body);
      if (!v.ok) return reply.code(v.code).send({ error: v.error });
      const { req: mreq, clip, ref } = v;

      const targetAsset = doc.assets[clip.assetId];
      const refAsset = doc.assets[ref.assetId];
      if (!targetAsset) return reply.code(404).send({ error: `에셋 없음: ${clip.assetId}` });
      if (!refAsset) return reply.code(404).send({ error: `에셋 없음: ${ref.assetId}` });

      const refKeyNow = refSourceKeyOf(ref, doc.assets);
      const existing = clip.source?.matchTo;

      // 이미 잰 값이 그대로 유효하면 다시 재지 않는다. 강도만 바뀌었으면 문서만 고친다
      // (강도는 굽는 시점에 아핀 사상을 보간할 뿐 — 통계와 무관하다).
      if (canReuseLevels(existing, mreq, refKeyNow)) {
        if (existing!.strength !== mreq.strength) {
          await ctx.applyBatch(id, [
            {
              type: 'updateClip',
              clipId,
              patch: { source: { ...(clip.source ?? {}), matchTo: { ...existing!, strength: mreq.strength } } },
            },
          ]);
          return { measured: false, updated: true };
        }
        return { measured: false, updated: false };
      }

      const job = ctx.jobs.enqueue(
        'matchStats',
        id,
        async (_j, report) => {
          const docNow = await ctx.store.get(id);
          const nowV = validateMatchRequest(docNow, clipId, body);
          if (!nowV.ok) throw new Error(nowV.error);
          const nowClip = nowV.clip;
          const nowRef = nowV.ref;
          const nowTargetAsset = docNow.assets[nowClip.assetId];
          const nowRefAsset = docNow.assets[nowRef.assetId];
          if (!nowTargetAsset || !nowRefAsset) throw new Error('에셋이 사라졌습니다');

          // 기준 컷: 파생 파일이 있으면 «그것» 을 잰다 — 사용자가 보는 색이 기준이어야 한다.
          // 대상 컷: 원본. S3 의 필터 순서상 matchTo 는 원본 위에서 계산된다.
          const key = refSourceKeyOf(nowRef, docNow.assets);
          const refRel = key === 'raw' ? bakeSrcOf(nowRef, nowRefAsset) : nowRefAsset.derived![key]!.src;
          const tgtRel = bakeSrcOf(nowClip, nowTargetAsset);

          const refRegion = nowV.req.refRegion ?? nowRef.crop;
          const tgtRegion = nowV.req.region ?? nowClip.crop;

          const refOut = await measureChannelHistograms(path.join(ctx.mediaDir, refRel), {
            atMs: timesOf(nowRef),
            ...(refRegion ? { region: refRegion } : {}),
            // 기준이 파생 파일이면 stabilize 는 이미 그 파일에 구워져 있다.
            // 원본을 재는 경우에만 보정을 걸어 «사용자가 보게 될» 그림으로 맞춘다.
            ...(key === 'raw' && nowRef.kind === 'video' && nowRef.source?.stabilize
              ? { stabilize: nowRef.source.stabilize }
              : {}),
          });
          report(0.5);
          const tgtOut = await measureChannelHistograms(path.join(ctx.mediaDir, tgtRel), {
            atMs: timesOf(nowClip),
            ...(tgtRegion ? { region: tgtRegion } : {}),
            // S3 의 필터 순서가 stabilize → matchTo 라, 색 맞추기는 «보정된» 프레임 위에서
            // 계산된다. 실측(measure.ts 주석)으로 원본과 채널 μ 가 최대 8/255 어긋난다.
            ...(nowClip.source?.stabilize ? { stabilize: nowClip.source.stabilize } : {}),
          });
          report(0.9);

          const { ref: refStats, target: tgtStats, report: rep } = buildReport(
            refOut.hist,
            tgtOut.hist,
            nowV.req.strength,
          );
          const levels: MatchLevels = {
            sampledAtMs: tgtOut.usedMs,
            refSourceKey: key,
            ref: refStats,
            target: tgtStats,
          };

          // colorlevels 로 표현 못 하는 조합이면 **문서를 고치기 전에** 실패시킨다.
          // 「대충 비슷하게」 구운 파일은 사용자가 왜 안 맞는지 알 수 없다.
          // matchColorLevels 가 표현 가능한 최대 강도를 계산해 메시지에 담아 던진다.
          matchColorLevels(levels, nowV.req.strength);

          await ctx.applyBatch(id, [
            {
              type: 'updateClip',
              clipId,
              patch: {
                source: {
                  ...(nowClip.source ?? {}),
                  matchTo: {
                    clipId: nowV.req.refClipId,
                    strength: nowV.req.strength,
                    ...(nowV.req.region ? { region: nowV.req.region } : {}),
                    ...(nowV.req.refRegion ? { refRegion: nowV.req.refRegion } : {}),
                    levels,
                  },
                },
              },
            },
          ]);
          return { clipId, refClipId: nowV.req.refClipId, sampledAtMs: tgtOut.usedMs, ...rep };
        },
        { key: `${clipId}:match`, timeoutMs: 10 * 60_000 },
      );
      return { jobId: job.id, measured: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

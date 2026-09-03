// GET /api/capabilities — schema 상수를 그대로 노출한다 (X6).
// UI·MCP 가 "이 서버가 뭘 할 수 있는가"를 하드코딩하지 않고 물어보게 하는 창구.
//
// W8 F17 — id 배열만 주면 **에이전트가 「대기(아직 안 그림)」인 효과를 골라 놓고 아무 일도
// 안 일어나는 것을 못 알아챈다.** 카탈로그를 통째로 같이 내보내 갈래·파라미터·대기 사유까지
// 알 수 있게 한다. 기존 id 배열은 그대로 둔다 (쓰던 쪽이 안 깨지게).
import type { FastifyInstance } from 'fastify';
import {
  BLEND_MODES,
  EFFECT_CATALOG,
  EFFECT_GROUP_LABELS,
  EFFECT_TYPES,
  LOUDNESS_TARGETS,
  PENDING_EFFECT_TYPES,
  SPEED_RAMP_PRESETS,
  TEXT_ANIM_TYPES,
  TEXT_TEMPLATES,
  TRANSITION_CATALOG,
  TRANSITION_GROUP_LABELS,
  TRANSITION_TYPES,
} from '@kitkat/schema';
import type { AppContext } from '../app.js';

export function registerCapabilityRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/capabilities', async () => ({
    transitions: TRANSITION_TYPES,
    effects: EFFECT_TYPES,
    textAnims: TEXT_ANIM_TYPES,
    textTemplates: TEXT_TEMPLATES,
    speedRampPresets: SPEED_RAMP_PRESETS,
    blendModes: BLEND_MODES,

    // ── 여기서부터 W8 F17 추가 ──
    /** 전환 전체 정보 (id·이름·갈래·필요한 것) */
    transitionCatalog: TRANSITION_CATALOG,
    /** 효과 전체 정보 (id·이름·갈래·구현 수단·파라미터·대기 사유) */
    effectCatalog: EFFECT_CATALOG,
    /**
     * **고르면 안 되는 효과 목록.** 렌더러가 아무것도 안 그린다.
     * 에이전트는 이 목록을 먼저 빼고 골라야 한다.
     */
    pendingEffects: PENDING_EFFECT_TYPES,
    transitionGroups: TRANSITION_GROUP_LABELS,
    effectGroups: EFFECT_GROUP_LABELS,
    /**
     * 목표 라우드니스 프리셋. **구글 광고 납품은 −24 LKFS 가 공식 규격**이고
     * 기본값 −14 는 공식 문서가 없는 관행값이다 — `official` 로 구분한다.
     */
    loudnessTargets: LOUDNESS_TARGETS,

    version: ctx.version,
  }));
}

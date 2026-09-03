// 노드 전용 root export (C4). 브라우저 안전 export는 "@kitkat/renderer/composition" 서브패스,
// 순수 합성 수식은 "@kitkat/renderer/layout" 서브패스.
export {
  renderProject,
  renderCover,
  renderAudioStem,
  type GlBackend,
  type RenderAudioCodec,
  type RenderProjectOptions,
  type RenderCoverOptions,
  type RenderAudioStemOptions,
} from './render.js';
export { startStaticServer, type StaticServer } from './static-server.js';

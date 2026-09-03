export {
  EngineError,
  applyCommand,
  applyCommands,
  findClip,
  assetPathFields,
  durationProblem,
  TRACK_ACCEPTS,
  KEYFRAME_PROPS,
  FORBIDDEN_PATCH_KEYS,
  type Command,
} from './apply.js';
export { checkInvariants } from './invariants.js';
export {
  duckKeyframes,
  voiceIntervalsFromEnvelope,
  DUCK_COMP_EASING,
  DUCK_SENSITIVITY_MS,
  DUCK_MIN_SPEECH_MS,
  DUCK_ADAPTIVE_DROP_DB,
  type DuckCurve,
  type DuckInterval,
  type VoiceEnvelope,
} from './duck.js';

// F11 공간감(리버브) IR 목록 — Voxengo IM Reverbs 38종.
//
// 설치: `node scripts/prewarm.mjs voice-ir` → vendor/ir/voxengo/<slug>.wav
// **리포에 넣지 않는다** (vendor/ 는 .gitignore, 6.7MB 바이너리).
// 여기 있는데 파일이 없으면 파생 잡이 **한국어 메시지로 실패**한다 — 조용히 건너뛰지 않는다.
//
// ⚠️ 라이선스: "royalty-free for any purpose, including commercial usage" 이지만
//    **파일 자체를 팔거나 배포로 수익을 내는 것은 금지**다. kitkat 을 «판매» 하게 되면 재확인.
//
// id 의 슬러그 규칙은 `scripts/prewarm.mjs` 의 `slugify` 와 «같아야 한다»
// (소문자화 → 영숫자 아닌 것을 '-' 로 → 양끝 '-' 제거).
export type VoiceIrOption = { id: string; label: string };

export const VOICE_IR_OPTIONS: VoiceIrOption[] = [
  { id: 'voxengo/block-inside', label: 'Block Inside' },
  { id: 'voxengo/bottle-hall', label: 'Bottle Hall' },
  { id: 'voxengo/cement-blocks-1', label: 'Cement Blocks 1' },
  { id: 'voxengo/cement-blocks-2', label: 'Cement Blocks 2' },
  { id: 'voxengo/chateau-de-logne-outside', label: 'Chateau de Logne, Outside' },
  { id: 'voxengo/conic-long-echo-hall', label: 'Conic Long Echo Hall' },
  { id: 'voxengo/deep-space', label: 'Deep Space' },
  { id: 'voxengo/derlon-sanctuary', label: 'Derlon Sanctuary' },
  { id: 'voxengo/direct-cabinet-n1', label: 'Direct Cabinet N1' },
  { id: 'voxengo/direct-cabinet-n2', label: 'Direct Cabinet N2' },
  { id: 'voxengo/direct-cabinet-n3', label: 'Direct Cabinet N3' },
  { id: 'voxengo/direct-cabinet-n4', label: 'Direct Cabinet N4' },
  { id: 'voxengo/five-columns', label: 'Five Columns' },
  { id: 'voxengo/five-columns-long', label: 'Five Columns Long' },
  { id: 'voxengo/french-18th-century-salon', label: 'French 18th Century Salon' },
  { id: 'voxengo/going-home', label: 'Going Home' },
  { id: 'voxengo/greek-7-echo-hall', label: 'Greek 7 Echo Hall' },
  { id: 'voxengo/highly-damped-large-room', label: 'Highly Damped Large Room' },
  { id: 'voxengo/in-the-silo', label: 'In The Silo' },
  { id: 'voxengo/in-the-silo-revised', label: 'In The Silo Revised' },
  { id: 'voxengo/large-bottle-hall', label: 'Large Bottle Hall' },
  { id: 'voxengo/large-long-echo-hall', label: 'Large Long Echo Hall' },
  { id: 'voxengo/large-wide-echo-hall', label: 'Large Wide Echo Hall' },
  { id: 'voxengo/masonic-lodge', label: 'Masonic Lodge' },
  { id: 'voxengo/musikvereinsaal', label: 'Musikvereinsaal' },
  { id: 'voxengo/narrow-bumpy-space', label: 'Narrow Bumpy Space' },
  { id: 'voxengo/nice-drum-room', label: 'Nice Drum Room' },
  { id: 'voxengo/on-a-star', label: 'On a Star' },
  { id: 'voxengo/parking-garage', label: 'Parking Garage' },
  { id: 'voxengo/rays', label: 'Rays' },
  { id: 'voxengo/right-glass-triangle', label: 'Right Glass Triangle' },
  { id: 'voxengo/ruby-room', label: 'Ruby Room' },
  { id: 'voxengo/scala-milan-opera-hall', label: 'Scala Milan Opera Hall' },
  { id: 'voxengo/small-drum-room', label: 'Small Drum Room' },
  { id: 'voxengo/small-prehistoric-cave', label: 'Small Prehistoric Cave' },
  { id: 'voxengo/st-nicolaes-church', label: 'St Nicolaes Church' },
  { id: 'voxengo/trig-room', label: 'Trig Room' },
  { id: 'voxengo/vocal-duo', label: 'Vocal Duo' },
];

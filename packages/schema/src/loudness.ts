// W8 F17 — 목표 라우드니스 프리셋.
//
// ## 왜 필요한가
// kitkat 은 **광고를 만드는 도구인데** 목표 라우드니스가 −14 LUFS 하나로 고정돼 있었다.
// 2026-09-02 에 1차 출처를 하나씩 열어 확인한 결과:
//
//  * **유튜브의 −14 LUFS 는 구글·유튜브 공식 문서에 없다.** 업로드 권장 설정 문서에는
//    코덱·채널·샘플레이트·비트레이트만 있고 라우드니스가 한 줄도 없다. 업계 관행값이다.
//  * **구글 광고(Campaign Manager 360 · Ad Manager · DV360)의 공식 규격은 −24 LKFS ±2** 다.
//    즉 −14 로 납품하면 **10dB 초과**라 플랫폼이 알아서 눌러 버린다.
//
// 그래서 값을 하나로 못 박지 않고 **어디로 내보내는지**로 고르게 한다.
//
// ## 트루피크는 여기서 안 정한다
// 지금 트루피크 목표는 `VOICE_TRUE_PEAK_DB = -1.0` 으로 고정이다(`@kitkat/media`).
// 아래 `truePeakDb` 는 **그 플랫폼이 요구하는 값을 적어 둔 참고 수치**이지 설정이 아니다.
// −1.0 은 스포티파이·애플·구글 광고 요구를 만족하지만 **넷플릭스(≤ −2 dBFS)는 못 맞춘다** —
// 넷플릭스 납품이 필요해지면 트루피크도 열어야 한다(`sourceKey` 에 넣는 것까지가 한 벌이다).

export type LoudnessTarget = {
  id: string;
  /** 인스펙터에 그대로 뜨는 이름 */
  label: string;
  /** loudnorm 의 I 값 (LUFS ≡ LKFS — 같은 것을 부르는 두 이름이다) */
  lufs: number;
  /** true = 플랫폼이 문서로 공표한 규격. false = 업계 관행값이라 근거 문서가 없다. */
  official: boolean;
  /** 그 플랫폼이 요구하는 트루피크(dBFS). 참고용 — 지금은 −1.0 고정이다. */
  truePeakDb: number;
  /** 1차 출처. 확인한 날짜는 이 파일 맨 위 주석에 있다. */
  source: string;
  /** 언제 고르는지 한 줄 */
  hint: string;
};

/**
 * 목표 라우드니스 프리셋. **기본값은 `youtube`(−14)** 로 두어 기존 문서의 결과가 안 바뀐다.
 * 광고 납품에는 `google-ads` 를 골라야 한다.
 */
export const LOUDNESS_TARGETS: readonly LoudnessTarget[] = [
  {
    id: 'youtube',
    label: '유튜브·소셜 업로드 (−14)',
    lufs: -14,
    official: false,
    truePeakDb: -1,
    source: '공식 문서 없음 — 업계 관행값',
    hint: '쇼츠·릴스·틱톡처럼 그냥 올리는 영상. 기본값입니다.',
  },
  {
    id: 'google-ads',
    label: '구글 광고 납품 (−24, 공식 규격)',
    lufs: -24,
    official: true,
    truePeakDb: -2,
    source: 'support.google.com/campaignmanager/answer/3312854 — IAB US 규격 −24 LKFS ±2',
    hint: 'Campaign Manager 360 · Ad Manager · DV360 으로 내보내는 광고 소재. −14 로 내면 10dB 초과다.',
  },
  {
    id: 'spotify',
    label: '스포티파이 (−14, 공식)',
    lufs: -14,
    official: true,
    truePeakDb: -1,
    source: 'support.spotify.com/us/artists/article/loudness-normalization/ — ITU 1770 기준 −14 dB LUFS',
    hint: '오디오 광고·팟캐스트 광고.',
  },
  {
    id: 'apple-podcast',
    label: '애플 팟캐스트 (−16, 공식)',
    lufs: -16,
    official: true,
    truePeakDb: -1,
    source: 'podcasters.apple.com/support/893-audio-requirements — −16 dB LKFS ±1, ITU-R BS.1770-5',
    hint: '팟캐스트로 나가는 것.',
  },
  {
    id: 'netflix',
    label: '넷플릭스 대사 (−27, 공식)',
    lufs: -27,
    official: true,
    truePeakDb: -2,
    source: 'partnerhelp.netflixstudios.com — 대사 −27 LKFS ±2, ITU-R BS.1770-1',
    hint: '트루피크 −2dBFS 도 함께 요구한다 — 지금 설정(−1.0)으로는 그쪽을 못 맞춘다.',
  },
] as const;

export type LoudnessTargetId = typeof LOUDNESS_TARGETS[number]['id'];

/** id 로 찾는다. 없으면 undefined — 호출부가 기본값을 정한다. */
export function loudnessTarget(id: string): LoudnessTarget | undefined {
  return LOUDNESS_TARGETS.find((t) => t.id === id);
}

/**
 * LUFS 값 → 가장 가까운 프리셋. 인스펙터가 「지금 값이 어느 프리셋인지」를 표시할 때 쓴다.
 * 같은 값이 둘이면(−14 가 둘) **먼저 나오는 것**(유튜브)을 돌려준다.
 */
export function loudnessTargetOf(lufs: number): LoudnessTarget | undefined {
  return LOUDNESS_TARGETS.find((t) => t.lufs === lufs);
}

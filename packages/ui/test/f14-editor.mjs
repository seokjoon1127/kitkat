// F14 — **실제 편집기, 실제 경로** 로 재는 드라이버.
//
// 이전 판은 편집기 안의 FrameProvider 를 밖에서 직접 불렀다. 그러면 편집기 자기 그리기 루프
// (재생헤드 위치)와 측정 루프(다른 위치)가 **같은 소스에 서로 다른 목표를 번갈아 힌트**해
// 디코드 창이 계속 재시작됐다 — 제품에는 없는 경합이다. 이제는 편집기가 실제로 받는 입력
// (→ / ← 키 = 한 프레임 이동)을 넣고, 편집기가 **자기 루프에서 그린** 프레임이 맞는
// 프레임이었는지(`window.__kitkatDraws`, DEV 전용 기록)를 센다.
//
// 사용: node f14-editor.mjs <base> <projectId> [runs]
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.argv[2] ?? 'http://localhost:5199';
const PROJECT = process.argv[3] ?? 'kZ55tAPqA6KFN7xj80kJ0';
const RUNS = Number(process.argv[4] ?? 1);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--enable-precise-memory-info',
  ],
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 900000,
});

async function measure(useWebCodecs) {
  const page = await browser.newPage();
  const errors = [];
  let gcWarnings = 0;
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => {
    const t = m.text();
    if (/garbage collected without/.test(t)) gcWarnings++;
    else if (m.type() === 'error') errors.push('[console] ' + t.slice(0, 160));
  });

  await page.goto(`${BASE}/?id=${PROJECT}${useWebCodecs ? '' : '&nowebcodecs=1'}`,
    { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('.topbar-toggle', { timeout: 30000 });
  await page.evaluate(() => {
    const l = [...document.querySelectorAll('label.topbar-toggle')]
      .find((x) => x.textContent?.includes('빠른 미리보기'));
    const b = l?.querySelector('input[type=checkbox]');
    if (b && !b.checked) b.click();
  });
  await page.waitForFunction('window.__kitkatPreview !== undefined && Array.isArray(window.__kitkatDraws)', { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const P = () => window.__kitkatPreview;
    const draws = () => window.__kitkatDraws;
    const key = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));

    /** 편집기가 마지막으로 그린 재생 위치 */
    const lastT = () => (draws().length ? draws()[draws().length - 1].tMs : NaN);

    /**
     * 키를 `ticks` 번, 화면 주기마다 `perTick` 번씩 누른다.
     * 그 사이 편집기가 그린 화면 중 «맞는 프레임이 아니었던» 비율을 낸다.
     */
    const drag = async (code, ticks, perTick) => {
      const from = draws().length;
      const t0 = performance.now();
      const startT = lastT();
      for (let i = 0; i < ticks; i++) {
        for (let k = 0; k < perTick; k++) key(code);
        await raf();
      }
      // 마지막 키의 그리기가 끝날 시간을 준다
      for (let i = 0; i < 3; i++) await raf();
      const seg = draws().slice(from);
      const stale = seg.filter((d) => !d.exact).length;
      // 어느 구간이 끊겼는지 보이게: 그린 순서대로 . = 맞음, X = 틀림 (타임라인 ms 와 함께)
      const pattern = seg.map((d) => (d.exact ? '.' : 'X')).join('');
      const staleAt = seg.filter((d) => !d.exact).map((d) => Math.round(d.tMs)).slice(0, 80);
      return {
        ticks, keys: ticks * perTick, draws: seg.length, stale, pattern, staleAt,
        stalePct: seg.length ? Math.round((stale / seg.length) * 1000) / 10 : null,
        movedMs: Math.round(lastT() - startT),
        wallMs: Math.round(performance.now() - t0),
        msPerTick: Math.round((performance.now() - t0) / ticks * 10) / 10,
      };
    };

    // 시동: 재생헤드를 클립 안(0.5초)으로 넣고 첫 «맞는» 화면이 나올 때까지
    const t0 = performance.now();
    for (let i = 0; i < 15; i++) { key('ArrowRight'); await raf(); }
    let startupMs = null;
    for (let i = 0; i < 600; i++) {
      const d = draws();
      if (d.length && d[d.length - 1].exact) { startupMs = Math.round(performance.now() - t0); break; }
      await raf();
    }
    const mem0 = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;

    const fwd = await drag('ArrowRight', 120, 1);   // 0.5s → 4.5s, 한 화면에 한 프레임
    const back = await drag('ArrowLeft', 120, 1);   // 4.5s → 0.5s
    const fast = await drag('ArrowRight', 30, 4);   // 한 화면에 4프레임(휙 끌기)
    const mem1 = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;

    return {
      webCodecs: P().webCodecs, startupMs, fwd, back, fast,
      stats: P().debugStats(), memMB0: mem0, memMB1: mem1,
    };
  });

  await page.close();
  return { ...result, gcWarnings, errors: errors.slice(0, 5) };
}

const out = [];
for (let i = 0; i < RUNS; i++) {
  out.push({ run: i + 1, webcodecs: await measure(true), fallback: await measure(false) });
}
process.stdout.write(JSON.stringify(out, null, 1));
await browser.close();

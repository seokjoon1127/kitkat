// F14 브라우저 실측 드라이버 — 설치된 Chrome 을 헤드리스(소프트웨어 렌더링)로 띄워
// 지정한 페이지를 열고 `window.__F14_*` 결과를 꺼내 stdout 에 JSON 으로 낸다.
//
// GPU 안전: 이 컴퓨터의 NVIDIA 드라이버가 GPU 작업 중 여러 번 죽었다.
// 그래서 ANGLE 를 강제하지 않고 **기본(SwiftShader/소프트웨어)** 으로만 돌린다.
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const url = process.argv[2];
const globalName = process.argv[3] ?? '__F14_PROBE';
const timeoutMs = Number(process.argv[4] ?? 180000);
if (!url) {
  console.error('usage: node f14-drive.mjs <url> [globalName] [timeoutMs]');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-gpu',                 // NVIDIA 를 건드리지 않는다
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--js-flags=--expose-gc',
    '--enable-precise-memory-info',
  ],
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.error(`[console:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction(`window.${globalName} !== undefined`, { timeout: timeoutMs, polling: 500 });
  const out = await page.evaluate((g) => window[g], globalName);
  process.stdout.write(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
}

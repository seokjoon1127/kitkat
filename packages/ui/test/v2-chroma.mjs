// V2-3 — 빠른 미리보기(WebGL)에서 크로마키가 실제로 화면에 걸리는가.
//
// 브라우저 확장으로 연 탭은 document.hidden 이라 rAF·비디오 디코딩이 조절돼 못 잰다.
// 헤드리스 Chrome 은 그 제약이 없다(F14·F15 가 쓴 방법 그대로). GPU 는 안 쓴다 — SwiftShader.
//
// ⚠️ `readPixels` 로는 못 읽는다 — 앱이 만든 WebGL 컨텍스트는 `preserveDrawingBuffer` 가 꺼져
//    있어서 화면에 내보낸 뒤 그리기 버퍼가 비워진다. 그래서 **캔버스를 스크린샷으로 찍어**
//    합성기가 실제로 화면에 올린 픽셀을 본다.
//
// 사용: node packages/ui/test/v2-chroma.mjs <프로젝트 id> [출력 png 경로]
import { writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5757';
const PID = process.argv[2];
const OUT = process.argv[3] ?? 'media/w8-v2/chroma-preview.png';
if (!PID) throw new Error('프로젝트 id 를 인자로 주세요');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--window-size=1400,1000',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

await page.goto(`${BASE}/p/${PID}`, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 2000));

const fast = process.argv.includes('--slow') ? false : true;
const toggled = await page.evaluate((want) => {
  const cb = [...document.querySelectorAll('input[type=checkbox]')].find((i) =>
    /빠른 미리보기/.test(i.closest('label')?.innerText || ''),
  );
  if (!cb) return 'checkbox 없음';
  if (cb.checked !== want) cb.click();
  return cb.checked;
}, fast);
await new Promise((r) => setTimeout(r, 4000));

// 그림이 그려지는 곳의 화면 좌표를 잡는다 (빠른 미리보기면 canvas, 아니면 미리보기 컨테이너)
const box = await page.evaluate(() => {
  const cs = [...document.querySelectorAll('canvas')].filter((c) => c.offsetWidth > 100);
  const el = cs[0] ?? document.querySelector('[class*="player"],[class*="preview"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, tag: el.tagName, size: `${el.width ?? ''}x${el.height ?? ''}` };
});
if (!box) throw new Error('그리는 요소를 못 찾음');

const png = await page.screenshot({
  clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.w), height: Math.round(box.h) },
});
await writeFile(OUT, png);

console.log(JSON.stringify({ 빠른미리보기: toggled, 요소: box, 저장: OUT, 페이지오류: errors.slice(0, 3) }, null, 1));
await browser.close();

// dist 를 v1(고치기 전) 크로마키 수식으로 임시 패치 — 「고치기 전」 픽셀 측정용.
import { readFileSync, writeFileSync } from 'node:fs';
const p = 'packages/renderer/dist/layout/index.js';
const s = readFileSync(p, 'utf8');
const old = "        effectStages.push({ kind: 'chromaKey', data: chromaKeyParams(clip.chromaKey) });";
const nu = `        { // [TEMP v1] RGB 벡터를 키 색 방향에 그대로 투영하던 v1 행렬
            const ck = clip.chromaKey;
            const mm = /^#?([0-9a-f]{6})$/i.exec(ck.color.trim());
            let kr = 0, kg = 1, kb = 0;
            if (mm) { const v = parseInt(mm[1], 16); kr = ((v >> 16) & 0xff) / 255; kg = ((v >> 8) & 0xff) / 255; kb = (v & 0xff) / 255; }
            const len = Math.hypot(kr, kg, kb) || 1;
            const nr = kr / len, ng = kg / len, nb = kb / len;
            const smooth = Math.max(0.02, Math.min(1, Math.max(0, ck.smoothness)));
            const threshold = len * (1 - Math.min(1, Math.max(0, ck.similarity)));
            const sc = 1 / smooth;
            effectStages.push({ kind: 'colorMatrix', data: { values: ['1 0 0 0 0','0 1 0 0 0','0 0 1 0 0', (-nr*sc)+' '+(-ng*sc)+' '+(-nb*sc)+' 1 '+(threshold*sc)].join(' ') } });
        }`;
if (!s.includes(old)) { console.error('앵커 없음 — 이미 패치됐거나 dist 가 다름'); process.exit(1); }
writeFileSync(p, s.replace(old, nu));
console.log('v1 패치 완료');

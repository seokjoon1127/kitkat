import { readFile } from 'node:fs/promises';

/**
 * .cube 3D LUT 파싱 검증 — `LUT_3D_SIZE N` 을 찾고 데이터 줄 수가 N^3 인지 확인한다.
 * 형식이 아니면 throw.
 */
export async function parseCubeLut(absPath: string): Promise<{ size: number }> {
  const text = await readFile(absPath, 'utf8');
  let size: number | null = null;
  let dataLines = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^LUT_3D_SIZE\s+(\d+)$/.exec(line);
    if (m) {
      size = Number(m[1]);
      continue;
    }
    if (/^[A-Za-z_]/.test(line)) continue; // TITLE / DOMAIN_MIN / DOMAIN_MAX 등 키워드 줄
    const parts = line.split(/\s+/);
    if (parts.length === 3 && parts.every((p) => p !== '' && Number.isFinite(Number(p)))) {
      dataLines++;
      continue;
    }
    throw new Error(`.cube 형식이 아닙니다: ${absPath}`);
  }
  if (size == null || size < 2) throw new Error(`.cube 에 LUT_3D_SIZE 가 없습니다: ${absPath}`);
  if (dataLines !== size * size * size) {
    throw new Error(`.cube 데이터 줄 수 불일치 (${dataLines} != ${size}^3): ${absPath}`);
  }
  return { size };
}

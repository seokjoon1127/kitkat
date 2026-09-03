// W0: 모노레포 스캐폴드 생성기 — 계획 문서 §W0 참조. 1회 실행용.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const root = process.cwd();
const write = (rel, content) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  console.log('wrote', rel);
};

const COMMON_DEV = {
  typescript: '^5.6.0',
  vitest: '^2.1.9',
  tsx: '^4.19.0',
  '@types/node': '^22.10.0',
};

// ---------- 루트 ----------
const order = ['schema', 'engine', 'media', 'ai', 'renderer', 'server', 'mcp', 'ui'];
const seq = (script) => order.map((n) => `npm run ${script} -w @kitkat/${n} --if-present`).join(' && ');
write('package.json', {
  name: 'kitkat',
  private: true,
  type: 'module',
  engines: { node: '>=22' },
  workspaces: ['packages/*'],
  scripts: {
    build: seq('build'),
    test: seq('test'),
    dev: 'npm run dev -w @kitkat/server',
    start: 'npm run start -w @kitkat/server',
    samples: 'node scripts/make-sample-media.mjs',
    demo: 'node scripts/demo-edit.mjs',
  },
});

write('tsconfig.base.json', {
  compilerOptions: {
    strict: true,
    target: 'ES2022',
    lib: ['ES2022'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    declaration: true,
    sourceMap: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    esModuleInterop: true,
    isolatedModules: true,
  },
});

write('.gitignore', ['node_modules/', 'dist/', 'media/', 'data/', '.remotion/', 'packages/ai/.venv/', '*.log', ''].join('\n'));

// ---------- 패키지 공통 헬퍼 ----------
const nodeExports = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } };
const nodePkg = (name, deps = {}, extra = {}) => ({
  name: `@kitkat/${name}`,
  version: '0.1.0',
  private: true,
  type: 'module',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: nodeExports,
  scripts: {
    build: 'tsc -p tsconfig.json',
    test: 'vitest run --passWithNoTests',
    ...extra.scripts,
  },
  dependencies: deps,
  devDependencies: { ...COMMON_DEV, ...(extra.devDependencies || {}) },
  ...(extra.top || {}),
});
const nodeTsconfig = (overrides = {}) => ({
  extends: '../../tsconfig.base.json',
  compilerOptions: { outDir: 'dist', rootDir: 'src', ...overrides },
  include: ['src'],
});
const placeholder = `// 자리표시자 — 담당 웨이브 에이전트가 구현으로 교체한다.\nexport {};\n`;

// ---------- schema ----------
write('packages/schema/package.json', nodePkg('schema', { zod: '^3.23.8', nanoid: '^5.0.9' }));
write('packages/schema/tsconfig.json', nodeTsconfig());
write('packages/schema/src/index.ts', placeholder);

// ---------- engine ----------
write('packages/engine/package.json', nodePkg('engine', { '@kitkat/schema': '*' }));
write('packages/engine/tsconfig.json', nodeTsconfig());
write('packages/engine/src/index.ts', placeholder);

// ---------- media ----------
write('packages/media/package.json', nodePkg('media', { execa: '^9.5.0' }));
write('packages/media/tsconfig.json', nodeTsconfig());
write('packages/media/src/index.ts', placeholder);

// ---------- ai ----------
write('packages/ai/package.json', nodePkg('ai', { execa: '^9.5.0' }));
write('packages/ai/tsconfig.json', nodeTsconfig());
write('packages/ai/src/index.ts', placeholder);
write('packages/ai/python/README.md', 'transcribe.py는 W3-E에서 생성된다. venv는 .venv/ (gitignore).\n');

// ---------- renderer (컴포지션 서브패스 export) ----------
write('packages/renderer/package.json', nodePkg('renderer', {
  '@kitkat/schema': '*',
  remotion: '^4.0.0',
  '@remotion/renderer': '^4.0.0',
  '@remotion/bundler': '^4.0.0',
  '@remotion/player': '^4.0.0',
  react: '^18.3.1',
  'react-dom': '^18.3.1',
}, {
  devDependencies: { '@types/react': '^18.3.12', '@types/react-dom': '^18.3.1' },
  top: {
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './composition': { types: './dist/composition/index.d.ts', import: './dist/composition/index.js' },
    },
  },
}));
write('packages/renderer/tsconfig.json', nodeTsconfig({ jsx: 'react-jsx', lib: ['ES2022', 'DOM', 'DOM.Iterable'] }));
write('packages/renderer/src/index.ts', placeholder);
write('packages/renderer/src/composition/index.ts', placeholder);

// ---------- server ----------
write('packages/server/package.json', nodePkg('server', {
  fastify: '^5.1.0',
  '@fastify/websocket': '^11.0.1',
  '@fastify/multipart': '^9.0.1',
  '@fastify/static': '^8.0.3',
  '@kitkat/schema': '*',
  '@kitkat/engine': '*',
  '@kitkat/media': '*',
  '@kitkat/renderer': '*',
  '@kitkat/ai': '*',
  execa: '^9.5.0',
  nanoid: '^5.0.9',
}, {
  scripts: { dev: 'tsx watch src/index.ts', start: 'node dist/index.js' },
}));
write('packages/server/tsconfig.json', nodeTsconfig());
write('packages/server/src/index.ts', placeholder);

// ---------- mcp ----------
write('packages/mcp/package.json', nodePkg('mcp', {
  '@modelcontextprotocol/sdk': '^1.0.0',
  zod: '^3.23.8',
}, { top: { bin: { 'kitkat-mcp': 'dist/index.js' } } }));
write('packages/mcp/tsconfig.json', nodeTsconfig());
write('packages/mcp/src/index.ts', placeholder);

// ---------- ui (vite 앱) ----------
write('packages/ui/package.json', {
  name: '@kitkat/ui',
  version: '0.1.0',
  private: true,
  type: 'module',
  scripts: {
    build: 'tsc --noEmit -p tsconfig.json && vite build',
    test: 'vitest run --passWithNoTests',
    dev: 'vite',
  },
  dependencies: {
    react: '^18.3.1',
    'react-dom': '^18.3.1',
    zustand: '^5.0.2',
    remotion: '^4.0.0',
    '@remotion/player': '^4.0.0',
    '@kitkat/schema': '*',
    '@kitkat/engine': '*',
    '@kitkat/renderer': '*',
  },
  devDependencies: {
    ...COMMON_DEV,
    vite: '^6.0.0',
    '@vitejs/plugin-react': '^4.3.4',
    '@types/react': '^18.3.12',
    '@types/react-dom': '^18.3.1',
  },
});
write('packages/ui/tsconfig.json', {
  extends: '../../tsconfig.base.json',
  compilerOptions: {
    noEmit: true,
    module: 'ESNext',
    moduleResolution: 'Bundler',
    jsx: 'react-jsx',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    types: ['vite/client'],
  },
  include: ['src'],
});
write('packages/ui/index.html', `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>kitkat 편집기</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`);
write('packages/ui/vite.config.ts', `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:5757',
      '/media': 'http://127.0.0.1:5757',
      '/healthz': 'http://127.0.0.1:5757',
      '/ws': { target: 'ws://127.0.0.1:5757', ws: true },
    },
  },
  build: { outDir: 'dist' },
});
`);
write('packages/ui/src/main.tsx', `// 자리표시자 — W3-A가 구현으로 교체한다.
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('root')!).render(<p>kitkat UI 준비 중</p>);
`);

if (!existsSync(join(root, 'media'))) mkdirSync(join(root, 'media'), { recursive: true });
if (!existsSync(join(root, 'data'))) mkdirSync(join(root, 'data', 'projects'), { recursive: true });
console.log('scaffold done');

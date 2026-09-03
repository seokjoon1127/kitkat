// 앱 셸 — 다크 3패널(미디어·플레이어·인스펙터) + 하단 타임라인 (CapCut류 레이아웃)
import { useEffect, useState } from 'react';
import { useEditor } from './state.js';
import { createProject, listProjects, type ProjectSummary } from './api.js';
import { TopBar } from './components/TopBar.js';
import { MediaPanel } from './components/MediaPanel.js';
import { PlayerPane } from './components/PlayerPane.js';
import { Timeline } from './components/Timeline.js';
import { Inspector } from './components/Inspector.js';

function projectIdFromUrl(): string | null {
  const m = location.pathname.match(/\/p\/([^/]+)/);
  if (m) return m[1] ?? null;
  return new URLSearchParams(location.search).get('id');
}

/** /p/:id 없이 열었을 때의 최소 프로젝트 선택 화면 */
function ProjectPicker() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then((r) => setProjects(r.projects))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const open = (id: string) => {
    location.href = `/p/${id}`;
  };

  const create = async () => {
    try {
      const { doc } = await createProject({ name: '새 프로젝트' });
      open(doc.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="picker">
      <div className="picker-card">
        <h1 className="logo">kitkat</h1>
        <p className="dim">편집할 프로젝트를 선택하거나 새로 만드세요.</p>
        {error && <p className="error-text">{error}</p>}
        {projects === null && !error && <p className="dim">불러오는 중…</p>}
        {projects && projects.length === 0 && <p className="dim">아직 프로젝트가 없습니다.</p>}
        <ul className="picker-list">
          {projects?.map((p) => (
            <li key={p.id}>
              <button className="picker-item" onClick={() => open(p.id)}>
                <span>{p.name}</span>
                <span className="dim">rev {p.revision}</span>
              </button>
            </li>
          ))}
        </ul>
        <button className="btn primary" onClick={() => void create()}>
          새 프로젝트
        </button>
      </div>
    </div>
  );
}

function NoticeToast() {
  const notice = useEditor((s) => s.notice);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => useEditor.setState({ notice: null }), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  if (!notice) return null;
  return (
    <div className="toast" onClick={() => useEditor.setState({ notice: null })}>
      {notice}
    </div>
  );
}

export function App() {
  const [projectId] = useState(projectIdFromUrl);
  const connect = useEditor((s) => s.connect);
  const doc = useEditor((s) => s.doc);

  useEffect(() => {
    if (projectId) connect(projectId);
  }, [projectId, connect]);

  if (!projectId) return <ProjectPicker />;

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <aside className="panel panel-left">
          <MediaPanel />
        </aside>
        <main className="panel-center">
          <PlayerPane />
        </main>
        <aside className="panel panel-right">{doc ? <Inspector /> : null}</aside>
      </div>
      <section className="panel-bottom">{doc ? <Timeline /> : null}</section>
      <NoticeToast />
    </div>
  );
}

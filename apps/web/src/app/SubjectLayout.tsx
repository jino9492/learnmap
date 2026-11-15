import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  errorMessage,
  idSchema,
  post,
  request,
  subjectKey,
  subjectSchema,
  subjectUrl,
  workspaceSchema,
} from "../utils/api";
import {
  SubjectContext,
  useOperations,
  useRefreshSubject,
} from "../hooks/useWorkspace";
import { Modal, NotFound, FeedbackBanners } from "../components/Shared";
import { SidebarMaterials } from "../features/materials/components/SidebarMaterials";
import { UploadDialog } from "../features/materials/components/MaterialsPage";
import { AnalysisProgress } from "../components/AnalysisProgress";
const remember = (id: string) => {
  try {
    localStorage.setItem("learnmap.subjectId", id);
  } catch {
    /* Storage is optional. */
  }
};

export const SubjectLayout = () => {
  const queryClient = useQueryClient();
  const { subjectId = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const location = useLocation();
  const operations = useOperations();
  const refresh = useRefreshSubject();
  const [upload, setUpload] = useState(false);
  const [create, setCreate] = useState(false);
  const [name, setName] = useState("");
  const workspace = useQuery({
    queryKey: ["workspace"],
    queryFn: () => request("/api/workspace", workspaceSchema),
  });
  const query = useQuery({
    queryKey: subjectKey(subjectId),
    queryFn: () =>
      request(`/api/subjects/${encodeURIComponent(subjectId)}`, subjectSchema),
    refetchInterval: (query) =>
      query.state.data?.materials.some(
        (item) => !["ready", "failed"].includes(item.status),
      )
        ? 1500
        : false,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 404) && count < 1,
  });
  useEffect(() => {
    remember(subjectId);
    setUpload(false);
    setCreate(false);
  }, [subjectId]);
  useEffect(() => {
    window.scrollTo(0, 0);
    const title = location.pathname.endsWith("/history")
      ? "나의 학습 기록"
      : location.pathname.endsWith("/learning-path")
        ? "학습 경로"
        : location.pathname.endsWith("/quiz")
          ? "이해도 평가"
          : location.pathname.includes("/concepts/")
            ? "개념 상세"
            : location.pathname.endsWith("/materials")
              ? "학습 자료"
              : "지식 그래프";
    document.title = `LearnMap · ${title}`;
    document.getElementById("main")?.focus();
  }, [location.pathname]);
  useEffect(() => {
    if (
      query.data?.materials.every((material) =>
        ["ready", "failed"].includes(material.status),
      )
    )
      void workspace.refetch();
  }, [
    query.data?.materials
      .map((material) => `${material.id}:${material.status}`)
      .join("|"),
  ]);
  if (query.isPending) return <p role="status">과목을 불러오고 있습니다.</p>;
  if (query.isError)
    return query.error instanceof ApiError && query.error.status === 404 ? (
      <NotFound />
    ) : (
      <div role="alert">
        <p>{errorMessage(query.error)}</p>
        <button onClick={() => void query.refetch()}>다시 시도</button>
      </div>
    );
  const subject = query.data;
  const active = subject.materials.filter(
    (material) => !["ready", "failed"].includes(material.status),
  );
  return (
    <SubjectContext.Provider value={subject}>
      <header className="topbar">
        <Link className="brand" to="/" aria-label="LearnMap 홈">
          <img
            className="brand-mark"
            src="/assets/favicon.svg"
            width="34"
            height="34"
            alt=""
          />
          LearnMap
        </Link>
        <span id="subject-pill" className="pill blue">
          {subject.name}
        </span>
        <nav aria-label="주요 메뉴">
          <NavLink to={subjectUrl(subjectId)}>나의 학습 지도</NavLink>
          <NavLink to={subjectUrl(subjectId, "learning-path")}>
            학습 경로
          </NavLink>
          <NavLink to={subjectUrl(subjectId, "history")}>학습 기록</NavLink>
        </nav>
        <label className="search">
          <span className="sr-only">개념 검색</span>
          <input
            id="search"
            type="search"
            placeholder="개념 검색"
            autoComplete="off"
            value={searchParams.get("q") ?? ""}
            onChange={(event) => {
              const next = new URLSearchParams(searchParams);
              if (event.target.value) next.set("q", event.target.value);
              else next.delete("q");
              if (location.pathname.endsWith("/graph"))
                setSearchParams(next, { replace: true });
              else navigate(`${subjectUrl(subjectId)}?${next}`);
            }}
          />
        </label>
        <button
          className="primary compact"
          onClick={() => setUpload(true)}
          disabled={operations.busy}
        >
          자료 추가
        </button>
        <div className="avatar" aria-label="로컬 학습자">
          <img src="/assets/avatar.svg" width="36" height="36" alt="" />
          <span>LM</span>
        </div>
      </header>
      <FeedbackBanners />
      <div
        id="workspace"
        className={`workspace${location.pathname.endsWith("/graph") ? "" : " wide"}`}
      >
        <aside id="sidebar" className="sidebar">
          <div className="section-label">
            <span>과목</span>
            <button
              className="icon-button"
              aria-label="과목 추가"
              onClick={() => setCreate(true)}
            >
              +
            </button>
          </div>
          <div id="subjects" className="subject-list">
            {workspace.data?.subjects.map((item) => (
              <button
                key={item.id}
                className={`subject-item${item.id === subjectId ? " selected" : ""}`}
                aria-pressed={item.id === subjectId}
                disabled={operations.busy}
                onClick={() => navigate(subjectUrl(item.id))}
              >
                <strong>{item.name}</strong>
                <small>{item.conceptCount}개 개념</small>
              </button>
            ))}
          </div>
          <button
            id="toggle-materials"
            className="mobile-materials secondary compact"
            aria-expanded={materialsOpen}
            aria-controls="material-section"
            onClick={() => setMaterialsOpen(!materialsOpen)}
          >
            자료 관리 · {subject.materials.length}개
          </button>
          <div
            id="material-section"
            className={`material-section${materialsOpen ? " is-open" : ""}`}
          >
            <div className="section-label materials-label">
              <Link to={subjectUrl(subjectId, "materials")}>자료</Link>
            </div>
            <SidebarMaterials />
            <button className="upload-card" onClick={() => setUpload(true)}>
              <span className="plus">+</span>
              <span>
                <strong>학습 자료 추가</strong>
                <small>PDF · TXT · Markdown</small>
              </span>
            </button>
          </div>
          <div className="sidebar-bottom">
            <span className="pill neutral">개인 학습 공간</span>
            <p>자료와 학습 기록은 이 컴퓨터에 저장됩니다.</p>
          </div>
        </aside>
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      {active.length > 0 && (
        <div className="analysis-banner">
          <div>
            <strong>학습 지도를 만들고 있어요</strong>
            <span role="status">
              현재 생성 작업 {active.length}건 · 자료별 진행률
            </span>
          </div>
          <button
            className="secondary compact"
            onClick={() => {
              void query.refetch();
              void queryClient.invalidateQueries({
                queryKey: ["analysis-progress"],
              });
            }}
          >
            상태 새로고침
          </button>
          <ul className="analysis-materials" aria-label="자료별 분석 진행 상황">
            {active.map((material) => (
              <AnalysisProgress key={material.id} material={material} />
            ))}
          </ul>
        </div>
      )}
      {upload && <UploadDialog onClose={() => setUpload(false)} />}
      {create && (
        <Modal
          titleId="subject-title"
          onClose={() => setCreate(false)}
          busy={operations.busy}
          error={operations.error}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void operations.run("과목을 만들고 있습니다.", async () => {
                const result = await post("/api/subjects", idSchema, {
                  name: name.trim(),
                });
                await refresh(subjectId);
                setCreate(false);
                setName("");
                navigate(subjectUrl(result.id));
              });
            }}
          >
            <div className="dialog-heading">
              <h2 id="subject-title">새 과목 만들기</h2>
              <button
                type="button"
                className="icon-button"
                onClick={() => setCreate(false)}
                aria-label="닫기"
              >
                ×
              </button>
            </div>
            <label>
              과목명
              <input
                autoFocus
                required
                maxLength={80}
                placeholder="예: 운영체제"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <button className="primary full" disabled={operations.busy}>
              과목 만들기
            </button>
          </form>
        </Modal>
      )}
    </SubjectContext.Provider>
  );
};

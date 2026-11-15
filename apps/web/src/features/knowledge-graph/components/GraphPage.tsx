import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { createGraph } from "../../../../graph.ts";
import { UploadDialog } from "../../materials/components/MaterialsPage";
import type { GraphController, GraphArrangements } from "../../../../graph.ts";
import {
  useOperations,
  useSubject,
  useRefreshSubject,
} from "../../../hooks/useWorkspace";
import { conceptUrl, pathSchema, post } from "../../../utils/api";
import {
  SourceLinks,
  Prerequisites,
  StatusBadge,
} from "../../../components/Shared";

// Keep user node positions while route pages mount and unmount in the current tab.
const arrangements: GraphArrangements = new Map();

export const GraphPage = () => {
  const subject = useSubject();
  const operations = useOperations();
  const { busy } = operations;
  const navigate = useNavigate();
  const refresh = useRefreshSubject();
  const [upload, setUpload] = useState(false);
  const [params, setParams] = useSearchParams();
  const selectedId =
    params.get("concept") ?? subject.graph.concepts[0]?.id ?? null;
  const query = params.get("q") ?? "";
  const filter = params.get("filter") ?? "ALL";
  const svg = useRef<SVGSVGElement>(null);
  const controller = useRef<GraphController | null>(null);
  const selection = useRef((id: string) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("concept", id);
      return next;
    });
  });
  const [count, setCount] = useState(0);
  useEffect(() => {
    selection.current = (id: string) => {
      setParams((previous) => {
        const next = new URLSearchParams(previous);
        next.set("concept", id);
        return next;
      });
    };
  }, [setParams]);
  useEffect(() => {
    if (!svg.current) return;
    const graph = createGraph(
      svg.current,
      (id) => selection.current(id),
      arrangements,
    );
    controller.current = graph;
    return () => {
      graph.destroy();
      controller.current = null;
    };
  }, []);
  useEffect(() => {
    const graph = controller.current;
    if (graph)
      setCount(
        graph.render({
          graphId: subject.id,
          name: subject.name,
          ...subject.graph,
          progress: subject.progress,
          path: subject.path,
          selectedId,
          query,
          filter,
        }),
      );
  }, [subject, selectedId, query, filter]);
  const concept = subject.graph.concepts.find((item) => item.id === selectedId);
  const progress = subject.progress.find(
    (item) => item.conceptId === selectedId,
  );
  const changeParam = (key: string, value: string) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  return (
    <section className="map-view">
      <div className="map-main">
        <div className="map-heading">
          <div>
            <h1>{subject.name} 지식 그래프</h1>
            <p>{`자료 ${subject.materials.length}개 · 개념 ${subject.graph.concepts.length}개 · 연결 ${subject.graph.relations.length}개`}</p>
          </div>
          <div id="filters" className="filters" aria-label="이해도 필터">
            {[
              { value: "ALL", label: "전체", color: "" },
              { value: "MASTERED", label: "이해", color: "green" },
              { value: "REVIEW_REQUIRED", label: "복습", color: "amber" },
              { value: "WEAK", label: "부족", color: "red" },
              { value: "NOT_STARTED", label: "미학습", color: "neutral" },
            ].map((item) => (
              <button
                key={item.value}
                className={`pill ${item.color}${filter === item.value ? " active" : ""}`}
                aria-pressed={filter === item.value}
                onClick={() => changeParam("filter", item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="graph-card">
          <div className="graph-toolbar">
            <button
              className="pill blue"
              onClick={() => navigate(`/subjects/${subject.id}/learning-path`)}
            >
              현재 추천 경로
            </button>
            <span>노드 드래그: 배치 변경 · 빈 공간 드래그: 지도 이동</span>
          </div>
          <svg
            id="graph"
            ref={svg}
            viewBox="0 0 846 646"
            role="group"
            aria-label="개념 관계 그래프"
            tabIndex={0}
          >
            <g />
          </svg>
          {!subject.graph.concepts.length && (
            <div className="empty-state">
              <span className="empty-mark">+</span>
              <h2>첫 번째 학습 지도를 만들어 보세요</h2>
              <p>
                강의 자료를 추가하면 AI가 핵심 개념과
                <br />
                개념 사이의 연결을 찾아드립니다.
              </p>
              <button className="primary" onClick={() => setUpload(true)}>
                학습 자료 추가
              </button>
            </div>
          )}
          <div className="graph-controls">
            <button
              aria-label="그래프 전체 보기"
              onClick={() => controller.current?.fit()}
            >
              ⊡
            </button>
            <button
              aria-label="그래프 확대"
              onClick={() => controller.current?.zoom(1 / 1.2)}
            >
              +
            </button>
            <button
              aria-label="그래프 축소"
              onClick={() => controller.current?.zoom(1.2)}
            >
              −
            </button>
          </div>
          <span className="graph-count">{count}개 개념 표시</span>
        </div>
        <div id="stats" className="stats">
          {[
            { status: "MASTERED", label: "이해 완료", color: "green" },
            { status: "REVIEW_REQUIRED", label: "복습 필요", color: "amber" },
            { status: "WEAK", label: "이해 부족", color: "red" },
          ].map((item) => (
            <span key={item.status} className={`pill ${item.color}`}>
              {item.label}{" "}
              {
                subject.graph.concepts.filter(
                  (concept) =>
                    subject.progress.find(
                      (entry) => entry.conceptId === concept.id,
                    )?.status === item.status,
                ).length
              }
            </span>
          ))}
        </div>
        <div className="graph-legend">
          <span className="edge-key parent">부모 → 선택 노드</span>
          <span className="edge-key child">선택 노드 → 자식</span>
          <span className="edge-key prerequisite">선수 → 선택 노드</span>
          <span className="edge-key dependent">선택 노드 → 후속</span>
          <span className="edge-key related">연관 관계 (점선)</span>
        </div>
      </div>
      <aside className="panel concept-detail" aria-label="개념 상세 정보">
        {concept ? (
          <>
            <h2>{concept.name}</h2>
            <StatusBadge status={progress?.status ?? "NOT_STARTED"} />
            <div className="detail-section">
              <h3>현재 이해도</h3>
              <div className="score">
                {progress ? `${progress.score}%` : "아직 평가 전"}
              </div>
              <progress
                max={100}
                value={progress?.score ?? 0}
                aria-label="현재 이해도"
              />
            </div>
            <div className="detail-section">
              <h3>개념 요약</h3>
              <p>{concept.description}</p>
              <Link
                className="secondary full detail-link"
                to={conceptUrl(subject.id, concept.id)}
              >
                세부 개념 전체 보기
              </Link>
            </div>
            <div className="detail-section">
              <h3>선수 개념</h3>
              <Prerequisites conceptId={concept.id} />
            </div>
            <div className="detail-section">
              <h3>관련 자료</h3>
              <SourceLinks source={concept} />
            </div>
            <div className="detail-actions">
              <Link
                className="primary full"
                aria-disabled={busy}
                to={conceptUrl(subject.id, concept.id, true)}
              >
                이 개념 문제 풀기
              </Link>
              <button
                className="secondary full"
                disabled={busy}
                onClick={() =>
                  void operations.run(
                    "선수 관계와 학습 기록을 분석하고 있습니다.",
                    async () => {
                      await post(
                        `/api/analyses/${subject.id}/path`,
                        pathSchema,
                        { conceptId: concept.id },
                      );
                      await refresh(subject.id);
                      navigate(
                        `/subjects/${subject.id}/learning-path?concept=${encodeURIComponent(concept.id)}`,
                      );
                    },
                  )
                }
              >
                추천 학습 경로 보기
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>개념 살펴보기</h2>
            <p className="empty-detail">
              {selectedId
                ? "선택한 개념이 없습니다. 다른 개념을 선택해 주세요."
                : "그래프에서 개념을 선택하면 설명과 선수 개념, 관련 자료를 확인할 수 있습니다."}
            </p>
          </>
        )}
      </aside>
      {upload && <UploadDialog onClose={() => setUpload(false)} />}
    </section>
  );
};

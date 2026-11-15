import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { conceptProjection, explorationGroups } from "../graph-view";
import type { DisplayConcept } from "../graph-view";
import { z } from "zod";
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
  const merge = params.get("merge") !== "0";
  const projection = useMemo(
    () =>
      conceptProjection(
        subject.graph.concepts,
        subject.graph.relations,
        merge ? subject.graph.equivalences : [],
        merge ? subject.graph.coreGroups : [],
      ),
    [subject.graph, merge],
  );
  const groups = useMemo(
    () => explorationGroups(projection.concepts, projection.relations),
    [projection],
  );
  const large = projection.concepts.length > 24;
  const selectedId =
    params.get("concept") ??
    (large ? null : (subject.graph.concepts[0]?.id ?? null));
  const canonicalSelected = selectedId
    ? (projection.canonicalIds.get(selectedId) ?? selectedId)
    : null;
  const query = params.get("q") ?? "";
  const filter = params.get("filter") ?? "ALL";
  const groupId = params.get("group");
  const activeGroup = groups.find((group) => group.id === groupId);
  const view =
    query || filter !== "ALL"
      ? "all"
      : (params.get("view") ??
        (activeGroup
          ? "group"
          : large
            ? params.has("concept")
              ? "focus"
              : "groups"
            : "all"));
  const scope = useMemo(() => {
    if (view === "groups")
      return {
        concepts: groups.map((group): DisplayConcept => ({
          id: group.id,
          name: group.name,
          description: `${group.memberIds.length}개 개념의 탐색 그룹`,
          evidence: "",
          sourceLocation: "",
          groupSize: group.memberIds.length,
        })),
        relations: [],
        layoutRelations: [],
      };
    let ids: Set<string> | undefined;
    if (view === "group" && activeGroup) ids = new Set(activeGroup.memberIds);
    if (view === "focus" && canonicalSelected) {
      const connected = projection.relations
        .filter(
          (edge) =>
            edge.source === canonicalSelected ||
            edge.target === canonicalSelected,
        )
        .sort(
          (a, b) => Number(a.type === "RELATED") - Number(b.type === "RELATED"),
        );
      ids = new Set(
        [
          canonicalSelected,
          ...connected.flatMap((edge) => [edge.source, edge.target]),
        ].slice(0, 36),
      );
    }
    const concepts = ids
      ? projection.concepts.filter((concept) => ids.has(concept.id))
      : projection.concepts;
    const visibleIds = new Set(concepts.map((concept) => concept.id));
    return {
      concepts,
      layoutRelations: projection.relations.filter(
        (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
      ),
      relations: projection.relations.filter(
        (edge) =>
          visibleIds.has(edge.source) &&
          visibleIds.has(edge.target) &&
          (edge.type !== "RELATED" ||
            edge.source === canonicalSelected ||
            edge.target === canonicalSelected),
      ),
    };
  }, [view, groups, activeGroup, projection, canonicalSelected]);
  const displayProgress = useMemo(
    () =>
      projection.concepts.flatMap((concept) => {
        const records = (concept.members ?? [concept]).flatMap((member) =>
          subject.progress.filter((entry) => entry.conceptId === member.id),
        );
        if (!records.length) return [];
        const score = Math.min(...records.map((entry) => entry.score));
        return [
          {
            conceptId: concept.id,
            score,
            status:
              records.length < (concept.members?.length ?? 1)
                ? ("NOT_STARTED" as const)
                : score >= 80
                  ? ("MASTERED" as const)
                  : score >= 50
                    ? ("REVIEW_REQUIRED" as const)
                    : ("WEAK" as const),
          },
        ];
      }),
    [projection, subject.progress],
  );
  const svg = useRef<SVGSVGElement>(null);
  const controller = useRef<GraphController | null>(null);
  const selection = useRef((id: string) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (id.startsWith("group:")) {
        next.set("group", id);
        next.set("view", "group");
        next.delete("concept");
      } else next.set("concept", id);
      return next;
    });
  });
  const [count, setCount] = useState(0);
  useEffect(() => {
    selection.current = (id: string) => {
      setParams((previous) => {
        const next = new URLSearchParams(previous);
        if (id.startsWith("group:")) {
          next.set("group", id);
          next.set("view", "group");
          next.delete("concept");
        } else next.set("concept", id);
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
          graphId: `${subject.id}:radial-branches-v3:${view}:${activeGroup?.id ?? ""}:${view === "focus" ? canonicalSelected : ""}:${query}:${filter}`,
          name:
            activeGroup && view === "group" ? activeGroup.name : subject.name,
          ...scope,
          progress: displayProgress,
          path: subject.path,
          selectedId: canonicalSelected,
          query,
          filter,
        }),
      );
  }, [
    subject,
    scope,
    displayProgress,
    canonicalSelected,
    query,
    filter,
    view,
    activeGroup,
  ]);
  const concept = subject.graph.concepts.find((item) => item.id === selectedId);
  const selectedDisplay = projection.concepts.find(
    (item) => item.id === canonicalSelected,
  );
  const progress = subject.progress.find(
    (item) => item.conceptId === selectedId,
  );
  const changeParam = (key: string, value: string) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set(key, value);
        else next.delete(key);
        if (key === "view") {
          next.delete("q");
          next.delete("filter");
        }
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
            <p>{`자료 ${subject.materials.length}개 · 지도 개념 ${projection.concepts.length}개 · 원본 항목 ${subject.graph.concepts.length}개 · 연결 ${projection.relations.length}개`}</p>
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
        {view === "groups" && (
          <nav className="graph-group-list" aria-label="탐색 그룹 목록">
            {groups.map((group) => (
              <button
                key={group.id}
                className="secondary"
                onClick={() => selection.current(group.id)}
              >
                {group.name} · {group.memberIds.length}개
              </button>
            ))}
          </nav>
        )}
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
          <span className="graph-count">
            {count}개 {view === "groups" ? "탐색 그룹" : "개념"} 표시
          </span>
        </div>
        <div className="graph-navigation" aria-label="지도 탐색 방식">
          <label className="graph-merge-toggle">
            <input
              type="checkbox"
              checked={merge}
              onChange={(event) =>
                setParams((previous) => {
                  const next = new URLSearchParams(previous);
                  next.set("merge", event.target.checked ? "1" : "0");
                  next.delete("group");
                  next.set("view", "groups");
                  return next;
                })
              }
            />
            <span>핵심·동일 개념 묶기</span>
          </label>
          <button
            className="secondary"
            aria-pressed={view === "groups"}
            onClick={() => {
              changeParam("view", "groups");
            }}
          >
            그룹 개요
          </button>
          <button
            className="secondary"
            aria-pressed={view === "all"}
            onClick={() => changeParam("view", "all")}
          >
            전체 개념
          </button>
          <button
            className="secondary"
            disabled={!selectedId}
            aria-pressed={view === "focus"}
            onClick={() => changeParam("view", "focus")}
          >
            선택 개념 주변
          </button>
          <button
            className="secondary graph-organize"
            disabled={busy || subject.graph.concepts.length < 2}
            onClick={() =>
              void operations.run(
                "동일 개념을 원문 근거로 확인하고 있습니다.",
                async () => {
                  await post(
                    `/api/subjects/${subject.id}/organize`,
                    z.object({ groups: z.number() }),
                    {},
                  );
                  await refresh(subject.id);
                },
              )
            }
          >
            동일 개념 정리
          </button>
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
          <span className="edge-key topic">주제 연결 (탐색용)</span>
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
            <h2>
              {selectedDisplay?.representative
                ? selectedDisplay.name
                : concept.name}
            </h2>
            {selectedDisplay && (selectedDisplay.members?.length ?? 0) > 1 && (
              <div className="detail-section">
                <label htmlFor="original-concept">
                  {selectedDisplay.representative
                    ? "세부 학습 항목 · 원본"
                    : "같은 개념의 원본 항목"}
                </label>
                <select
                  id="original-concept"
                  value={concept.id}
                  onChange={(event) =>
                    changeParam("concept", event.target.value)
                  }
                >
                  {selectedDisplay.members?.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name} ·{" "}
                      {subject.materials.find(
                        (material) =>
                          material.id === member.sourceLocation.split("/")[0],
                      )?.title ?? member.sourceLocation}
                    </option>
                  ))}
                </select>
                <p>원본별 설명·문제·학습 기록은 그대로 보존됩니다.</p>
              </div>
            )}
            <StatusBadge status={progress?.status ?? "NOT_STARTED"} />
            {selectedDisplay?.representative && (
              <p className="helper">
                현재 선택 항목: {concept.name}. 아래 이해도·설명·문제는 이 원본
                항목에 해당합니다.
              </p>
            )}
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

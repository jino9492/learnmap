import { Link, useSearchParams } from "react-router-dom";
import { useSubject } from "../../../hooks/useWorkspace";
import { conceptUrl } from "../../../utils/api";
import {
  buildLearningPath,
  companionConcepts,
} from "../../../../../shared/learning-path";
import { StatusBadge, statusColors } from "../../../components/Shared";

export const PathPage = () => {
  const subject = useSubject();
  const [params, setParams] = useSearchParams();
  const target = params.get("concept") ?? undefined;
  const path = buildLearningPath(subject.graph, subject.progress, target);
  const steps = path?.steps ?? [];
  const companions = companionConcepts(
    subject.graph,
    steps.map((step) => step.conceptId),
    Boolean(target),
  );
  const nextStep = steps.find(
    (step) =>
      subject.progress.find((item) => item.conceptId === step.conceptId)
        ?.status !== "MASTERED",
  );
  const mastered = subject.progress.filter(
    (item) => item.status === "MASTERED",
  ).length;
  const weak = subject.progress
    .filter((item) => ["WEAK", "REVIEW_REQUIRED"].includes(item.status))
    .sort((a, b) => a.score - b.score);
  return (
    <section id="path-view" className="page-view" aria-labelledby="path-title">
      <div className="page-heading">
        <h1 id="path-title">학습 경로</h1>
        <p>
          학습 전에도 선수 관계를 따라 경로를 확인하고, 이해도에 맞춰 다음
          학습을 이어가세요.
        </p>
        <div id="path-tags" className="tags">
          <span className="pill blue">{subject.name}</span>
          <span className="pill neutral">{steps.length}개 개념</span>
        </div>
      </div>
      <div className="page-grid">
        <div className="panel path-card">
          <h2>추천 순서</h2>
          <p className="muted">
            선수 개념을 먼저 배우고, 같은 단계에서는 이해도가 낮은 개념부터
            학습합니다.
          </p>
          <label>
            목표 개념
            <select
              aria-label="목표 개념"
              value={target ?? ""}
              onChange={(event) =>
                setParams(
                  event.target.value ? { concept: event.target.value } : {},
                )
              }
            >
              <option value="">과목 전체</option>
              {subject.graph.concepts.map((concept) => (
                <option key={concept.id} value={concept.id}>
                  {concept.name}
                </option>
              ))}
            </select>
          </label>
          <div id="path-steps" className="path-steps">
            {steps.map((step, index) => (
              <Link
                key={step.conceptId}
                className={`path-step${step.conceptId === nextStep?.conceptId ? " selected" : ""}`}
                title={step.reason}
                to={conceptUrl(subject.id, step.conceptId, true)}
              >
                <span className="step-number">{index + 1}</span>
                <strong>
                  {subject.graph.concepts.find(
                    (concept) => concept.id === step.conceptId,
                  )?.name ?? "개념"}
                </strong>
                <StatusBadge
                  status={
                    subject.progress.find(
                      (item) => item.conceptId === step.conceptId,
                    )?.status ?? "NOT_STARTED"
                  }
                />
              </Link>
            ))}
            {!steps.length && (
              <div className="quiz-empty">
                <p>
                  {target
                    ? "선택한 개념의 경로를 찾을 수 없습니다. 목표 개념을 다시 선택해 주세요."
                    : "자료를 추가하고 분석하면 학습 경로가 표시됩니다."}
                </p>
              </div>
            )}
          </div>
          <div className="insight">
            <h3>왜 이 순서인가요?</h3>
            <p id="path-reason">
              {path?.possibleCause ??
                "목표 개념을 선택하면 연결된 선수 개념부터 순서대로 표시합니다."}
            </p>
            <span className="pill blue">선수 관계 · 이해도 반영</span>
          </div>
          <section
            className="path-companions"
            aria-labelledby="path-companions-title"
          >
            <h3 id="path-companions-title">같이 보면 좋을 개념들</h3>
            <p className="muted">
              {target
                ? "경로의 개념과 연관된 다른 개념들입니다. 관심 있는 개념을 함께 살펴보세요."
                : "서로 연관된 개념들입니다. 목표 개념을 선택하면 해당 경로와 연관된 다른 개념을 모아 볼 수 있습니다."}
            </p>
            {companions.length ? (
              <ul className="path-companion-list">
                {companions.map((item) => (
                  <li key={item.conceptId} className="path-companion-card">
                    <Link to={conceptUrl(subject.id, item.conceptId)}>
                      {
                        subject.graph.concepts.find(
                          (concept) => concept.id === item.conceptId,
                        )?.name
                      }
                    </Link>
                    <StatusBadge
                      status={
                        subject.progress.find(
                          (entry) => entry.conceptId === item.conceptId,
                        )?.status ?? "NOT_STARTED"
                      }
                    />
                    <ul className="path-companion-connections">
                      {item.connections.map((connection) => (
                        <li key={connection.conceptId}>
                          <Link
                            to={conceptUrl(subject.id, connection.conceptId)}
                          >
                            {
                              subject.graph.concepts.find(
                                (concept) =>
                                  concept.id === connection.conceptId,
                              )?.name
                            }
                          </Link>
                          {connection.reason
                            ? ` · ${connection.reason}`
                            : "와 연관된 개념입니다."}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">함께 볼 연관 개념이 아직 없습니다.</p>
            )}
          </section>
        </div>
        <aside id="path-progress" className="panel path-progress">
          <h2>학습 진행</h2>
          <div className="detail-section">
            <h3>이해 완료</h3>
            <div className="score">
              {mastered} / {subject.graph.concepts.length} 개념
            </div>
            <progress
              max={Math.max(1, subject.graph.concepts.length)}
              value={mastered}
              aria-label="이해 완료 개념 비율"
            />
          </div>
          <div className="detail-section">
            <h3>취약 개념</h3>
            {weak.length ? (
              <div>
                {weak.slice(0, 4).map((item) => (
                  <div
                    key={item.conceptId}
                    className={`weak-card ${statusColors[item.status]}`}
                  >
                    <div>
                      <strong>
                        {subject.graph.concepts.find(
                          (concept) => concept.id === item.conceptId,
                        )?.name ?? "삭제된 개념"}
                      </strong>
                      <small>이해도 {item.score}%</small>
                    </div>
                    <span className={`pill ${statusColors[item.status]}`}>
                      {item.status === "WEAK" ? "우선" : "복습"}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">
                문제 풀이 후 취약 개념을 확인할 수 있습니다.
              </p>
            )}
          </div>
          <div className="detail-section">
            <h3>추천 경로</h3>
            <div className="score">{steps.length}개 개념</div>
          </div>
          {nextStep ? (
            <Link
              className="primary"
              to={conceptUrl(subject.id, nextStep.conceptId, true)}
            >
              학습 시작
            </Link>
          ) : (
            <button className="primary" disabled>
              {steps.length ? "경로 학습 완료" : "학습 시작"}
            </button>
          )}
          <p className="small">
            문제를 풀면 누적 이해도가 자동으로 갱신됩니다.
          </p>
        </aside>
      </div>
    </section>
  );
};

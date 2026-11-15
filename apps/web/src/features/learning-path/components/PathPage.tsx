import { Link, useSearchParams } from "react-router-dom";
import {
  useOperations,
  useRefreshSubject,
  useSubject,
} from "../../../hooks/useWorkspace";
import { conceptUrl, pathSchema, post } from "../../../utils/api";
import { StatusBadge, statusColors } from "../../../components/Shared";

export const PathPage = () => {
  const subject = useSubject();
  const [params] = useSearchParams();
  const target = params.get("concept") ?? subject.graph.concepts[0]?.id;
  const operations = useOperations();
  const refresh = useRefreshSubject();
  const steps = subject.path?.steps ?? [];
  const mastered = subject.progress.filter(
    (item) => item.status === "MASTERED",
  ).length;
  const weak = subject.progress
    .filter((item) => ["WEAK", "REVIEW_REQUIRED"].includes(item.status))
    .sort((a, b) => a.score - b.score);
  const generate = () =>
    void operations.run(
      "선수 관계와 학습 기록을 분석하고 있습니다.",
      async () => {
        const result = await post(
          `/api/analyses/${subject.id}/path`,
          pathSchema,
          { conceptId: target },
        );
        await refresh(subject.id);
        if (result.localization?.warning)
          operations.notify(result.localization.warning);
      },
    );
  return (
    <section id="path-view" className="page-view" aria-labelledby="path-title">
      <div className="page-heading">
        <h1 id="path-title">오늘의 추천 학습 경로</h1>
        <p>현재 이해도와 선수 개념을 기준으로 학습 순서를 제안합니다.</p>
        <div id="path-tags" className="tags">
          <span className="pill blue">{subject.name}</span>
          <span className="pill neutral">{steps.length}개 개념</span>
        </div>
      </div>
      <div className="page-grid">
        <div className="panel path-card">
          <h2>추천 순서</h2>
          <p className="muted">
            이해가 부족한 개념의 선수 관계를 따라 구성된 경로입니다.
          </p>
          <div id="path-steps" className="path-steps">
            {steps.map((step, index) => (
              <Link
                key={step.conceptId}
                className={`path-step${index === 0 ? " selected" : ""}`}
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
                <p>아직 추천 경로가 없습니다.</p>
                <button
                  className="secondary"
                  disabled={!target || operations.busy}
                  onClick={generate}
                >
                  선택한 개념으로 경로 생성
                </button>
              </div>
            )}
          </div>
          <div className="insight">
            <h3>왜 이 순서인가요?</h3>
            <p id="path-reason">
              {subject.path?.possibleCause ??
                "그래프에서 목표 개념을 선택하면 선수 관계와 누적 풀이 기록을 바탕으로 학습 순서를 제안합니다."}
            </p>
            <span className="pill blue">AI 분석 · 원인 후보</span>
          </div>
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
          {steps[0] ? (
            <Link
              className="primary"
              to={conceptUrl(subject.id, steps[0].conceptId, true)}
            >
              학습 시작
            </Link>
          ) : (
            <button className="primary" disabled>
              학습 시작
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

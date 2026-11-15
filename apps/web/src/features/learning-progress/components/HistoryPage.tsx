import { Link } from "react-router-dom";
import { useSubject } from "../../../hooks/useWorkspace";
import { subjectUrl } from "../../../utils/api";
import { Empty } from "../../../components/Shared";

export const HistoryPage = () => {
  const subject = useSubject();
  return (
    <section className="page-view">
      <div className="page-heading">
        <h1>나의 학습 기록</h1>
        <p>문제 풀이와 이해도의 변화를 함께 확인하세요.</p>
      </div>
      <div className="history-list">
        {subject.history
          .slice()
          .reverse()
          .map((entry, index) => (
            <article className="panel history-card" key={index}>
              <header>
                <h3>{entry.conceptName}</h3>
                <time dateTime={entry.createdAt}>
                  {new Date(entry.createdAt).toLocaleString("ko-KR")}
                </time>
              </header>
              <span
                className={`pill ${(entry.score ?? 0) >= 80 ? "green" : (entry.score ?? 0) >= 50 ? "amber" : "red"}`}
              >
                {entry.status === "FAILED"
                  ? "평가 실패"
                  : entry.status === "PENDING"
                    ? "평가 중"
                    : `${entry.score}점`}
              </span>
              <p>{entry.question}</p>
              <p className="muted">
                {entry.feedback ?? "답안 평가를 진행하고 있습니다."}
              </p>
              <details>
                <summary>제출한 답안 보기</summary>
                <p>{entry.answer}</p>
              </details>
            </article>
          ))}
        {!subject.history.length && (
          <Empty title="첫 번째 학습을 시작해 보세요">
            <p>개념별 문제를 풀면 평가와 피드백이 여기에 쌓입니다.</p>
            <Link className="secondary" to={subjectUrl(subject.id)}>
              지식 그래프 보기
            </Link>
          </Empty>
        )}
      </div>
    </section>
  );
};

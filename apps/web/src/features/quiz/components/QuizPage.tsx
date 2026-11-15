import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useOperations,
  useRefreshSubject,
  useSubject,
} from "../../../hooks/useWorkspace";
import {
  evaluationSchema,
  post,
  questionSetSchema,
  subjectUrl,
} from "../../../utils/api";
import type { Evaluation, QuestionSet } from "../../../utils/api";
import {
  NotFound,
  SourceLinks,
  Prerequisites,
} from "../../../components/Shared";

interface QuizSession {
  set: QuestionSet;
  index: number;
  answer: string;
  evaluation: Evaluation | null;
}
const sessionKey = (subjectId: string, conceptId: string) =>
  `learnmap.quiz:${subjectId}:${conceptId}`;
const restore = (key: string): QuizSession | null => {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("set" in raw) ||
      !("index" in raw) ||
      !("answer" in raw) ||
      !("evaluation" in raw)
    )
      return null;
    const parsed = questionSetSchema.safeParse(raw.set);
    if (
      !parsed.success ||
      !Number.isInteger(raw.index) ||
      typeof raw.index !== "number" ||
      raw.index < 0 ||
      raw.index >= parsed.data.questions.length ||
      typeof raw.answer !== "string"
    )
      return null;
    const evaluation =
      raw.evaluation === null ? null : evaluationSchema.parse(raw.evaluation);
    return {
      set: parsed.data,
      index: raw.index,
      answer: raw.answer,
      evaluation,
    };
  } catch {
    return null;
  }
};
export const QuizPage = () => {
  const subject = useSubject();
  const { conceptId = "" } = useParams();
  const concept = subject.graph.concepts.find((item) => item.id === conceptId);
  if (!concept) return <NotFound />;
  return (
    <QuizContent key={`${subject.id}:${conceptId}`} conceptId={conceptId} />
  );
};
const QuizContent = ({ conceptId }: { conceptId: string }) => {
  const subject = useSubject();
  const concept = subject.graph.concepts.find((item) => item.id === conceptId)!;
  const operations = useOperations();
  const refresh = useRefreshSubject();
  const key = sessionKey(subject.id, conceptId);
  const [session, setSession] = useState<QuizSession | null>(() =>
    restore(key),
  );
  const [type, setType] = useState("ESSAY");
  const [difficulty, setDifficulty] = useState("MEDIUM");
  const update = (next: QuizSession | null) => {
    setSession(next);
    try {
      if (next) sessionStorage.setItem(key, JSON.stringify(next));
      else sessionStorage.removeItem(key);
    } catch {
      /* The active session still works without storage. */
    }
  };
  const question = session?.set.questions[session.index];
  const progress = subject.progress.find(
    (item) => item.conceptId === conceptId,
  );
  const answered = session ? session.index + (session.evaluation ? 1 : 0) : 0;
  return (
    <section className="page-view">
      <div className="page-heading">
        <h1>{concept.name} · 이해도 평가</h1>
        <p>학습 자료를 바탕으로 생성된 문제를 풀고 이해도를 확인하세요.</p>
        <div className="tags">
          <span className="pill blue">AI 생성 문제</span>
          <span className="pill neutral">
            {question
              ? {
                  ESSAY: "서술형",
                  SHORT_ANSWER: "단답형",
                  MULTIPLE_CHOICE: "객관식",
                }[question.question.type]
              : "문제 설정"}
          </span>
        </div>
      </div>
      <div className="page-grid">
        <div className="panel quiz-card">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void operations.run(
                "개념의 세부 범위를 확인하는 문제 묶음을 생성하고 있습니다.",
                async () => {
                  const set = await post(
                    `/api/analyses/${subject.id}/questions`,
                    questionSetSchema,
                    { conceptId, type, difficulty },
                  );
                  update({ set, index: 0, answer: "", evaluation: null });
                  await refresh(subject.id);
                },
              );
            }}
          >
            <fieldset disabled={operations.busy}>
              <legend>문제 설정</legend>
              <div className="form-row">
                <label>
                  문제 유형
                  <select
                    value={type}
                    onChange={(event) => setType(event.target.value)}
                  >
                    <option value="ESSAY">서술형</option>
                    <option value="SHORT_ANSWER">단답형</option>
                    <option value="MULTIPLE_CHOICE">객관식</option>
                  </select>
                </label>
                <label>
                  난이도
                  <select
                    value={difficulty}
                    onChange={(event) => setDifficulty(event.target.value)}
                  >
                    <option value="EASY">쉬움</option>
                    <option value="MEDIUM">보통</option>
                    <option value="HARD">어려움</option>
                  </select>
                </label>
                <button className="primary">문제 생성</button>
              </div>
            </fieldset>
          </form>
          {session && question ? (
            <>
              <div className="quiz-meta">
                <span>
                  문제 {session.index + 1} / {session.set.total} ·{" "}
                  {question.topic}
                </span>
                <span>
                  {answered} / {session.set.total}문제 평가 완료
                </span>
              </div>
              <progress
                max={session.set.total}
                value={answered}
                aria-label="문제 풀이 진행률"
              />
              <p className="question-label">Q.</p>
              <h2 id="question-text">{question.question.question}</h2>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!session.answer.trim() || session.evaluation) return;
                  const submitted = session;
                  void operations.run(
                    "답안의 개념 이해도를 분석하고 있습니다.",
                    async () => {
                      const evaluation = await post(
                        `/api/analyses/${subject.id}/evaluations`,
                        evaluationSchema,
                        {
                          questionId: question.questionId,
                          answer: submitted.answer,
                        },
                      );
                      update({ ...submitted, evaluation });
                      await refresh(subject.id);
                    },
                  );
                }}
              >
                <fieldset
                  disabled={operations.busy || Boolean(session.evaluation)}
                >
                  <legend className="sr-only">답안 입력</legend>
                  {question.question.type === "MULTIPLE_CHOICE" ? (
                    <div className="answer-options">
                      {question.question.options.map((option) => (
                        <label className="choice" key={option}>
                          <input
                            type="radio"
                            name="answer"
                            required
                            value={option}
                            checked={session.answer === option}
                            onChange={() =>
                              update({ ...session, answer: option })
                            }
                          />
                          <span>{option}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <label id="written-answer">
                      <span className="sr-only">답안</span>
                      <textarea
                        id="answer"
                        placeholder="개념을 이해한 내용을 자신의 말로 설명해 주세요."
                        rows={6}
                        maxLength={8000}
                        required
                        value={session.answer}
                        onChange={(event) =>
                          update({ ...session, answer: event.target.value })
                        }
                      />
                    </label>
                  )}
                  <p className="answer-note">
                    제출 후 AI가 개념 이해도와 오개념을 분석합니다.
                  </p>
                  <div className="actions">
                    <Link className="secondary" to={subjectUrl(subject.id)}>
                      지식 그래프로
                    </Link>
                    <button className="primary">답안 제출</button>
                  </div>
                </fieldset>
              </form>
              {session.evaluation && (
                <div className="evaluation" role="status">
                  <h3>이번 문제 평가</h3>
                  <div className="score">
                    {session.evaluation.evaluation.score}점
                  </div>
                  <p>{session.evaluation.evaluation.feedback}</p>
                  <p>
                    개념 이해도 {session.evaluation.progress.score}% ·{" "}
                    {session.evaluation.progress.answered ?? answered}/
                    {session.evaluation.progress.total ?? session.set.total}문제
                    완료
                  </p>
                  {session.index + 1 < session.set.total ? (
                    <button
                      className="primary"
                      disabled={operations.busy}
                      onClick={() =>
                        update({
                          ...session,
                          index: session.index + 1,
                          answer: "",
                          evaluation: null,
                        })
                      }
                    >
                      다음 문제
                    </button>
                  ) : (
                    <p>모든 범위의 평가를 완료했습니다.</p>
                  )}
                  <Link
                    className="secondary"
                    to={`/subjects/${subject.id}/learning-path?concept=${encodeURIComponent(conceptId)}`}
                  >
                    추천 학습 경로 보기
                  </Link>
                </div>
              )}
            </>
          ) : (
            <div className="quiz-empty">
              <h2>배운 내용을 확인해 보세요</h2>
              <p>
                유형과 난이도를 선택하면 개념의 세부 범위와 분량에 맞춰 여러
                문제가 생성됩니다.
              </p>
            </div>
          )}
        </div>
        <aside id="quiz-info" className="panel quiz-info">
          <h2>학습 정보</h2>
          <p className="eyebrow">평가 대상 개념</p>
          <p className="info-name">{concept.name}</p>
          <span className="pill blue">
            현재 이해도 {progress ? `${progress.score}%` : "아직 평가 전"}
          </span>
          <div className="divider" />
          <div className="detail-section">
            <h3>선수 개념</h3>
            <Prerequisites conceptId={conceptId} />
          </div>
          <div className="detail-section">
            <h3>참고 학습 자료</h3>
            <SourceLinks source={concept} />
          </div>
          <div className="detail-section">
            <h3>학습 안내</h3>
            <p>
              개념의 세부 내용과 분량에 맞춰 문제 수를 자동으로 정합니다. 현재
              문제 묶음의 정답률과 풀이 범위를 함께 반영해 이해도를 갱신합니다.
              새 묶음의 첫 답안을 제출하면 이해도 평가가 새로 시작됩니다.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
};

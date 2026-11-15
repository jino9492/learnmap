import { useState } from "react";
import { z } from "zod";
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
import {
  NotFound,
  SourceLinks,
  Prerequisites,
} from "../../../components/Shared";

const quizSessionSchema = z.object({
  set: questionSetSchema,
  index: z.number().int().nonnegative(),
  answers: z.array(z.string()),
  evaluations: z.array(evaluationSchema.nullable()),
  submitted: z.boolean(),
});
type QuizSession = z.infer<typeof quizSessionSchema>;
const sessionKey = (subjectId: string, conceptId: string) =>
  `learnmap.quiz:${subjectId}:${conceptId}`;
const restore = (key: string): QuizSession | null => {
  try {
    const session = quizSessionSchema.parse(
      JSON.parse(sessionStorage.getItem(key) ?? "null"),
    );
    const total = session.set.questions.length;
    if (
      total === 0 ||
      session.set.total !== total ||
      session.index >= total ||
      session.answers.length !== total ||
      session.evaluations.length !== total ||
      (session.submitted && session.answers.some((answer) => !answer.trim())) ||
      (!session.submitted && session.evaluations.some(Boolean))
    )
      return null;
    return session;
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
  const answered =
    session?.answers.filter((answer) => answer.trim()).length ?? 0;
  const complete = Boolean(session?.evaluations.every(Boolean));
  const answer = session?.answers[session.index] ?? "";
  const setAnswer = (answer: string) => {
    if (!session) return;
    const answers = [...session.answers];
    answers[session.index] = answer;
    update({ ...session, answers });
  };
  return (
    <section className="page-view">
      <div className="page-heading">
        <div className="quiz-heading-row">
          <h1>{concept.name} · 이해도 평가</h1>
          <Link
            className="secondary"
            to={subjectUrl(
              subject.id,
              `graph?concept=${encodeURIComponent(conceptId)}`,
            )}
          >
            지식 그래프로
          </Link>
        </div>
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
                  update({
                    set,
                    index: 0,
                    answers: set.questions.map(() => ""),
                    evaluations: set.questions.map(() => null),
                    submitted: false,
                  });
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
                  {answered} / {session.set.total}문제 답안 작성
                </span>
              </div>
              <progress
                max={session.set.total}
                value={answered}
                aria-label="문제 풀이 진행률"
              />
              {!complete && (
                <>
                  <p className="question-label">Q.</p>
                  <h2 id="question-text">{question.question.question}</h2>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!answer.trim() || complete) return;
                      if (
                        !session.submitted &&
                        session.index + 1 < session.set.total
                      ) {
                        update({ ...session, index: session.index + 1 });
                        return;
                      }
                      if (answered !== session.set.total) return;
                      let submitted = { ...session, submitted: true };
                      update(submitted);
                      void operations.run(
                        "전체 답안을 채점하고 피드백을 준비하고 있습니다.",
                        async () => {
                          for (const [
                            index,
                            item,
                          ] of submitted.set.questions.entries()) {
                            if (submitted.evaluations[index]) continue;
                            const evaluation = await post(
                              `/api/analyses/${subject.id}/evaluations`,
                              evaluationSchema,
                              {
                                questionId: item.questionId,
                                answer: submitted.answers[index],
                              },
                            );
                            const evaluations = [...submitted.evaluations];
                            evaluations[index] = evaluation;
                            submitted = { ...submitted, evaluations };
                            update(submitted);
                          }
                          await refresh(subject.id);
                        },
                      );
                    }}
                  >
                    <fieldset disabled={operations.busy}>
                      <legend className="sr-only">답안 입력</legend>
                      {question.question.type === "MULTIPLE_CHOICE" ? (
                        <div className="answer-options">
                          {question.question.options.map((option) => (
                            <label className="choice" key={option}>
                              <input
                                type="radio"
                                name="answer"
                                required
                                disabled={session.submitted}
                                value={option}
                                checked={answer === option}
                                onChange={() => setAnswer(option)}
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
                            disabled={session.submitted}
                            value={answer}
                            onChange={(event) => setAnswer(event.target.value)}
                          />
                        </label>
                      )}
                      <p className="answer-note">
                        모든 문제를 푼 후 전체 답안을 제출하면 채점 결과와
                        피드백을 한꺼번에 확인할 수 있습니다.
                      </p>
                      <div className="actions">
                        {session.index > 0 && !session.submitted && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() =>
                              update({ ...session, index: session.index - 1 })
                            }
                          >
                            이전 문제
                          </button>
                        )}
                        <button className="primary">
                          {session.submitted
                            ? "채점 다시 시도"
                            : session.index + 1 < session.set.total
                              ? "다음 문제"
                              : "전체 답안 제출"}
                        </button>
                      </div>
                    </fieldset>
                  </form>
                </>
              )}
              {complete && (
                <div className="evaluation" role="status">
                  <h2>전체 채점 결과 및 피드백</h2>
                  <p>모든 {session.set.total}문제의 평가를 완료했습니다.</p>
                  <p>
                    개념 이해도 {session.evaluations.at(-1)!.progress.score}%
                  </p>
                  {session.set.questions.map((item, index) => {
                    const result = session.evaluations[index]!;
                    return (
                      <div className="detail-section" key={item.questionId}>
                        <h3>
                          문제 {index + 1} · {item.topic}
                        </h3>
                        <p>{item.question.question}</p>
                        <p>내 답안: {session.answers[index]}</p>
                        <div className="score">{result.evaluation.score}점</div>
                        <p>{result.evaluation.feedback}</p>
                      </div>
                    );
                  })}
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
              모든 문제의 답안을 제출한 뒤 채점하며, 결과와 피드백은 전체 채점이
              끝나면 함께 표시됩니다.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
};

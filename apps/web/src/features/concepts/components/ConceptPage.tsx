import { Link, useParams } from "react-router-dom";
import {
  useOperations,
  useRefreshSubject,
  useSubject,
} from "../../../hooks/useWorkspace";
import {
  conceptUrl,
  detailsSchema,
  post,
  subjectUrl,
} from "../../../utils/api";
import type { Concept } from "../../../utils/api";
import { NotFound, SourceLink, SourceLinks } from "../../../components/Shared";
import { explanationBlocks } from "../../../../explanation.ts";

export const ConceptPage = () => {
  const subject = useSubject();
  const { conceptId } = useParams();
  const operations = useOperations();
  const refresh = useRefreshSubject();
  const concept = subject.graph.concepts.find((item) => item.id === conceptId);
  if (!concept) return <NotFound />;
  const groups = new Map<
    string,
    {
      name: string;
      description: string;
      sources: Pick<Concept, "sourceLocation" | "evidence">[];
    }
  >();
  for (const detail of concept.details ?? [concept]) {
    const key = JSON.stringify([detail.name, detail.description]);
    const group = groups.get(key) ?? {
      name: detail.name,
      description: detail.description,
      sources: [],
    };
    if (
      !group.sources.some(
        (source) =>
          source.sourceLocation === detail.sourceLocation &&
          source.evidence === detail.evidence,
      )
    )
      group.sources.push(detail);
    groups.set(key, group);
  }
  return (
    <section className="page-view">
      <div className="page-heading">
        <Link
          to={subjectUrl(
            subject.id,
            `graph?concept=${encodeURIComponent(concept.id)}`,
          )}
        >
          ← 지식 그래프로
        </Link>
      </div>
      <div id="concept-content" className="concept-content">
        <h1>{concept.name}</h1>
        <p className="concept-summary">{concept.description}</p>
        <div className="actions">
          <Link
            className="primary"
            to={conceptUrl(subject.id, concept.id, true)}
          >
            이 개념 전체 평가하기
          </Link>
          <button
            className="secondary"
            disabled={operations.busy}
            onClick={() =>
              void operations.run(
                "원문을 바탕으로 상세 설명을 작성하고 있습니다.",
                async () => {
                  const result = await post(
                    `/api/analyses/${subject.id}/details`,
                    detailsSchema,
                    { conceptId: concept.id },
                  );
                  await refresh(subject.id);
                  if (result.localization?.warning)
                    operations.notify(result.localization.warning);
                },
              )
            }
          >
            상세 설명 다시 작성
          </button>
        </div>
        {Array.from(groups.values()).map((detail, index) => (
          <article className="panel concept-section" key={index}>
            <h2>
              {index + 1}. {detail.name}
            </h2>
            <div className="lesson-body">
              {explanationBlocks(detail.description).map((block, index) =>
                block.type === "code" ? (
                  <pre className="lesson-code" key={index}>
                    <code>{block.text}</code>
                  </pre>
                ) : block.type === "heading" ? (
                  <h3 className="lesson-heading" key={index}>
                    {block.text}
                  </h3>
                ) : (
                  <p className="concept-prose" key={index}>
                    {block.text}
                  </p>
                ),
              )}
            </div>
            <details>
              <summary>원문 근거 확인</summary>
              {detail.sources.map((source, index) => (
                <div key={index}>
                  <blockquote className="concept-prose">
                    {source.evidence}
                  </blockquote>
                  <SourceLink source={source} />
                </div>
              ))}
            </details>
          </article>
        ))}
        <div className="detail-section">
          <h3>전체 참고 자료</h3>
          <SourceLinks source={concept} />
        </div>
      </div>
    </section>
  );
};

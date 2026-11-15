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
import { conceptProjection } from "../../knowledge-graph/graph-view";

export const ConceptPage = () => {
  const subject = useSubject();
  const { conceptId } = useParams();
  const operations = useOperations();
  const refresh = useRefreshSubject();
  const concept = subject.graph.concepts.find((item) => item.id === conceptId);
  if (!concept) return <NotFound />;
  const projection = conceptProjection(
    subject.graph.concepts,
    subject.graph.relations,
    subject.graph.equivalences,
    subject.graph.coreGroups,
  );
  const displayed = projection.concepts.find(
    (item) => item.id === projection.canonicalIds.get(concept.id),
  );
  const representative = displayed?.representative ? displayed : null;
  const members = displayed?.members ?? [concept];
  const groups = new Map<
    string,
    {
      name: string;
      description: string;
      sources: Pick<Concept, "sourceLocation" | "evidence">[];
      ready: boolean;
    }
  >();
  for (const member of members)
    for (const detail of member.details ?? [member]) {
      const key = JSON.stringify([detail.name, detail.description]);
      const group = groups.get(key) ?? {
        name: detail.name,
        description: detail.description,
        sources: [],
        ready: false,
      };
      group.ready ||= member.detailsState !== "pending";
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
        <h1>{representative?.name ?? concept.name}</h1>
        <p className="concept-summary">
          {representative?.description ?? concept.description}
        </p>
        {members.length > 1 && (
          <section aria-label="대표 개념의 세부 학습 항목">
            <h2>세부 학습 항목</h2>
            <p>
              모든 항목의 설명과 근거를 아래에 모았습니다. 현재 선택:{" "}
              {concept.name}. 문제·이해도·설명 작성은 선택한 원본 항목별로
              유지됩니다.
            </p>
            <div className="actions">
              {members.map((member) => (
                <Link
                  className="secondary"
                  key={member.id}
                  to={conceptUrl(subject.id, member.id)}
                  aria-current={member.id === concept.id ? "page" : undefined}
                >
                  {member.name}
                </Link>
              ))}
            </div>
          </section>
        )}
        <div className="actions">
          <Link
            className="primary"
            to={conceptUrl(subject.id, concept.id, true)}
          >
            {members.length > 1
              ? "선택 항목 평가하기"
              : "이 개념 전체 평가하기"}
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
            {concept.detailsState === "pending"
              ? "상세 설명 작성"
              : "상세 설명 다시 작성"}
          </button>
        </div>
        {concept.detailsState === "pending" && (
          <p role="status">
            상세 설명은 필요할 때 작성합니다. 아래에서 세부 학습 항목과 원문
            근거를 확인하거나 ‘상세 설명 작성’을 눌러 주세요.
          </p>
        )}
        {Array.from(groups.values()).map((detail, index) => (
          <article className="panel concept-section" key={index}>
            <h2>
              {index + 1}. {detail.name}
            </h2>
            {detail.ready && (
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
            )}
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
          <SourceLinks source={representative ?? concept} />
        </div>
      </div>
    </section>
  );
};

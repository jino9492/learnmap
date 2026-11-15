import { Link } from "react-router-dom";
import { useEffect, useRef } from "react";
import { useSubject, useOperations } from "../hooks/useWorkspace";
import type { Citation, Status } from "../utils/api";
import {
  conceptProjection,
  prerequisiteConcepts,
} from "../features/knowledge-graph/graph-view";

interface ModalProps {
  titleId: string;
  onClose: () => void;
  busy: boolean;
  error?: string;
  children: React.ReactNode;
}
export const Modal = ({
  titleId,
  onClose,
  busy,
  error,
  children,
}: ModalProps) => {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      id={titleId.replace("-title", "-dialog")}
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      {children}
      {error && (
        <p role="alert" className="red">
          {error}
        </p>
      )}
    </dialog>
  );
};

export const statusLabels: Record<Status, string> = {
  NOT_STARTED: "미학습",
  MASTERED: "이해",
  REVIEW_REQUIRED: "복습 필요",
  WEAK: "이해 부족",
};
export const statusColors: Record<Status, string> = {
  NOT_STARTED: "neutral",
  MASTERED: "green",
  REVIEW_REQUIRED: "amber",
  WEAK: "red",
};
export const StatusBadge = ({ status }: { status: Status }) => (
  <span className={`pill ${statusColors[status]}`}>{statusLabels[status]}</span>
);
export const Empty = ({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) => (
  <div className="panel quiz-empty">
    <h2>{title}</h2>
    {children}
  </div>
);
export const SourceLink = ({ source }: { source: Citation }) => {
  const subject = useSubject();
  const [id, location] = source.sourceLocation.split("/");
  const material = subject.materials.find((item) => item.id === id);
  const page = /page:(\d+)/.exec(location ?? "")?.[1];
  return (
    <a
      className="source-card"
      href={`/api/materials/${encodeURIComponent(id)}/file${page ? `#page=${page}` : ""}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {material?.title ?? "원본 자료"}
      <small>{page ? `p. ${page} · ` : ""}원본 보기 ↗</small>
    </a>
  );
};
export const NotFound = () => (
  <section className="page-view">
    <Empty title="페이지를 찾을 수 없습니다">
      <p>주소 또는 삭제된 과목·개념인지 확인해 주세요.</p>
      <Link className="secondary" to="/">
        학습 공간으로
      </Link>
    </Empty>
  </section>
);

export const SourceLinks = ({
  source,
}: {
  source: import("../utils/api").Concept;
}) => {
  const sources = new Map(
    [source, ...(source.citations ?? [])].map((citation) => [
      citation.sourceLocation,
      citation,
    ]),
  );
  return (
    <>
      {Array.from(sources.values()).map((citation) => (
        <SourceLink key={citation.sourceLocation} source={citation} />
      ))}
    </>
  );
};
export const Prerequisites = ({ conceptId }: { conceptId: string }) => {
  const subject = useSubject();
  const projection = conceptProjection(
    subject.graph.concepts,
    subject.graph.relations,
    subject.graph.equivalences,
    subject.graph.coreGroups,
  );
  const concepts = prerequisiteConcepts(
    projection,
    subject.graph.relations,
    conceptId,
  );
  return concepts.length ? (
    <div className="tags">
      {concepts.map((concept) => (
        <Link
          key={concept.id}
          className={`pill ${statusColors[subject.progress.find((item) => item.conceptId === concept.id)?.status ?? "NOT_STARTED"]}`}
          to={`/subjects/${subject.id}/graph?concept=${encodeURIComponent(concept.id)}`}
        >
          {concept.name}
        </Link>
      ))}
    </div>
  ) : (
    <p>등록된 선수 개념이 없습니다.</p>
  );
};

export const FeedbackBanners = () => {
  const operations = useOperations();
  return (
    <>
      {operations.message && (
        <div id="notice" className="notice" role="status">
          <span>{operations.message}</span>
          {!operations.busy && (
            <button className="compact" onClick={() => operations.notify("")}>
              닫기
            </button>
          )}
        </div>
      )}
      {operations.error && (
        <div id="error" className="error-banner" role="alert">
          <span>{operations.error}</span>
          <button className="compact" onClick={operations.dismissError}>
            닫기
          </button>
        </div>
      )}
    </>
  );
};

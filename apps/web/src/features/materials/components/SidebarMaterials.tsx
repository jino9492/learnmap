import { useState } from "react";
import { z } from "zod";
import {
  useOperations,
  useRefreshSubject,
  useSubject,
} from "../../../hooks/useWorkspace";
import { Modal } from "../../../components/Shared";
import { idSchema, request } from "../../../utils/api";
import type { Material } from "../../../utils/api";

const labels: Record<string, string> = {
  queued: "분석 대기",
  extracting_text: "텍스트 추출 중",
  extracting_concepts: "개념 추출 중",
  organizing_concepts: "개념 정리 중",
  analyzing_relations: "관계 분석 중",
  localizing: "한국어 정리 중",
  linking_subject: "다른 자료와 연결 중",
  saving: "분석 저장 중",
  failed: "분석 실패 · 다시 분석할 수 있습니다",
  ready: "분석 완료",
};
export const SidebarMaterials = () => {
  const subject = useSubject();
  const operations = useOperations();
  const refresh = useRefreshSubject();
  const [removing, setRemoving] = useState<Material | null>(null);
  return (
    <>
      <div id="materials" className="material-list">
        {subject.materials.map((material) => {
          const pending = !["ready", "failed"].includes(material.status);
          return (
            <div key={material.id} className="material-item">
              <a
                className="material-name"
                href={`/api/materials/${material.id}/file`}
                target="_blank"
                rel="noopener"
                title={material.title}
              >
                {material.title}
              </a>
              <div className="material-actions">
                <button
                  aria-label={`${material.title} 다시 분석`}
                  disabled={operations.busy || pending}
                  onClick={() =>
                    void operations.run("자료를 다시 분석합니다.", async () => {
                      await request(
                        `/api/materials/${material.id}/analyze`,
                        idSchema,
                        { method: "POST" },
                      );
                      await refresh(subject.id);
                    })
                  }
                >
                  ↻
                </button>
                <button
                  aria-label={`${material.title} 삭제`}
                  disabled={operations.busy || pending}
                  onClick={() => setRemoving(material)}
                >
                  ×
                </button>
              </div>
              <small>
                {material.error
                  ? "분석 오류 · 다시 분석해 주세요"
                  : labels[material.status]}
              </small>
            </div>
          );
        })}
        {!subject.materials.length && (
          <p className="muted small">아직 추가한 자료가 없습니다.</p>
        )}
      </div>
      {removing && (
        <Modal
          titleId="delete-title"
          onClose={() => setRemoving(null)}
          busy={operations.busy}
          error={operations.error}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void operations.run("자료를 삭제하고 있습니다.", async () => {
                await request(
                  `/api/materials/${removing.id}`,
                  z.object({ deleted: z.boolean() }),
                  { method: "DELETE" },
                );
                setRemoving(null);
                await refresh(subject.id);
              });
            }}
          >
            <div className="dialog-heading">
              <h2 id="delete-title">학습 자료 삭제</h2>
              <button
                className="icon-button"
                type="button"
                aria-label="닫기"
                onClick={() => setRemoving(null)}
              >
                ×
              </button>
            </div>
            <p>‘{removing.title}’ 자료를 삭제하시겠습니까?</p>
            <p className="muted">
              이 자료의 원본과 개념 연결이 삭제됩니다. 다른 자료와 학습 이력은
              보관됩니다.
            </p>
            <div className="actions">
              <button
                className="secondary"
                type="button"
                onClick={() => setRemoving(null)}
              >
                취소
              </button>
              <button className="danger" disabled={operations.busy}>
                삭제
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
};

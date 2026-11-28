import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MIB } from "../../../../../shared/upload-limit.ts";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import {
  useOperations,
  useRefreshSubject,
  useSubject,
} from "../../../hooks/useWorkspace";
import {
  errorMessage,
  idSchema,
  request,
  subjectUrl,
  workspaceSchema,
} from "../../../utils/api";
import type { Material } from "../../../utils/api";
import { Empty, Modal } from "../../../components/Shared";

const materialLabels: Record<string, string> = {
  queued: "분석 대기",
  extracting_text: "본문 인식 중",
  extracting_concepts: "개념 추출 중",
  organizing_concepts: "개념 정리 중",
  analyzing_relations: "관계 분석 중",
  localizing: "한국어 정리 중",
  linking_subject: "다른 자료와 연결 중",
  saving: "저장 중",
  ready: "분석 완료",
  failed: "분석 실패",
};

const getMaterialState = (material: Material) => {
  if (material.status === "failed" || material.error) return "failed";
  if (material.status === "ready") return "ready";
  return "active";
};

export const MaterialsPage = () => {
  const subject = useSubject();
  const operations = useOperations();
  const refresh = useRefreshSubject();
  const [upload, setUpload] = useState(false);
  const [removing, setRemoving] = useState<Material | null>(null);
  const [filenameQuery, setFilenameQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const query = filenameQuery.trim().normalize().toLowerCase();
  const visibleMaterials = subject.materials.filter(
    (material) =>
      material.title.normalize().toLowerCase().includes(query) &&
      (statusFilter === "all" || getMaterialState(material) === statusFilter),
  );

  return (
    <section className="page-view">
      <div className="page-heading">
        <h1>학습 자료</h1>
        <p>원본 자료와 분석 상태를 관리합니다.</p>
        <button className="primary" onClick={() => setUpload(true)}>
          자료 추가
        </button>
      </div>
      {subject.materials.length > 0 && (
        <div className="material-filters">
          <label>
            파일명 검색
            <input
              type="search"
              value={filenameQuery}
              onChange={(event) => setFilenameQuery(event.target.value)}
            />
          </label>
          <label>
            분석 상태
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">전체</option>
              <option value="active">대기 및 진행 중</option>
              <option value="ready">{materialLabels.ready}</option>
              <option value="failed">{materialLabels.failed}</option>
            </select>
          </label>
        </div>
      )}
      <div className="history-list">
        {visibleMaterials.map((material) => (
          <article className="panel history-card" key={material.id}>
            <h2>
              <a
                href={`/api/materials/${material.id}/file`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {material.title} ↗
              </a>
            </h2>
            <p role="status">
              {getMaterialState(material) === "failed"
                ? materialLabels.failed
                : material.analysisProgress?.waiting
                  ? material.analysisProgress.label
                  : (materialLabels[material.status] ?? material.status)}
            </p>
            {Boolean(material.error) && (
              <p className="red" role="alert">
                분석 중 오류가 발생했습니다. 이전에 완료된 결과가 있다면
                유지됩니다. 다시 분석해 주세요.
              </p>
            )}
            {material.warnings?.map((warning, index) => (
              <p role="alert" key={index}>
                {warning}
              </p>
            ))}
            <div className="actions">
              <button
                className="secondary"
                disabled={
                  operations.busy ||
                  !["ready", "failed"].includes(material.status)
                }
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
                다시 분석
              </button>
              <button
                className="danger"
                disabled={
                  operations.busy ||
                  !["ready", "failed"].includes(material.status)
                }
                onClick={() => setRemoving(material)}
              >
                삭제
              </button>
            </div>
          </article>
        ))}
      </div>
      {!subject.materials.length && (
        <Empty title="추가한 학습 자료가 없습니다">
          <p>PDF, TXT, Markdown 자료를 추가해 보세요.</p>
        </Empty>
      )}
      {subject.materials.length > 0 && visibleMaterials.length === 0 && (
        <Empty title="조건에 맞는 학습 자료가 없습니다">
          <button
            className="secondary"
            onClick={() => {
              setFilenameQuery("");
              setStatusFilter("all");
            }}
          >
            검색 및 필터 초기화
          </button>
        </Empty>
      )}
      {upload && <UploadDialog onClose={() => setUpload(false)} />}
      {removing && (
        <Modal
          titleId="delete-title"
          onClose={() => setRemoving(null)}
          busy={operations.busy}
          error={operations.error}
        >
          <h2 id="delete-title">학습 자료 삭제</h2>
          <p>‘{removing.title}’ 자료의 원본과 개념 연결을 삭제하시겠습니까?</p>
          <p>다른 자료와 학습 이력은 보관됩니다.</p>
          <div className="actions">
            <button
              autoFocus
              className="secondary"
              onClick={() => setRemoving(null)}
            >
              취소
            </button>
            <button
              className="danger"
              disabled={operations.busy}
              onClick={() =>
                void operations.run("자료를 삭제하고 있습니다.", async () => {
                  await request(
                    `/api/materials/${removing.id}`,
                    z.object({ deleted: z.boolean() }),
                    { method: "DELETE" },
                  );
                  setRemoving(null);
                  await refresh(subject.id);
                })
              }
            >
              삭제
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
};

export const UploadDialog = ({ onClose }: { onClose: () => void }) => {
  const subject = useSubject();
  const navigate = useNavigate();
  const [uploadSubject, setUploadSubject] = useState(subject.id);
  const workspace = useQuery({
    queryKey: ["workspace"],
    queryFn: () => request("/api/workspace", workspaceSchema),
  });
  const operations = useOperations();
  const refresh = useRefreshSubject();
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState("conceptual");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const addFiles = (incoming: File[]) => {
    if (operations.busy) return;
    const invalid = incoming.find(
      (file) =>
        !/\.(pdf|txt|md)$/i.test(file.name) ||
        !file.size ||
        file.size > MAX_UPLOAD_BYTES,
    );
    if (invalid) {
      setError(
        `${invalid.name}: 비어 있지 않은 PDF, TXT, Markdown 파일을 선택해 주세요. 파일당 최대 ${MAX_UPLOAD_MIB} MiB입니다.`,
      );
      return;
    }
    setError("");
    setFiles((previous) => {
      const combined = [...previous];
      for (const file of incoming)
        if (
          !combined.some(
            (item) =>
              item.name === file.name &&
              item.size === file.size &&
              item.lastModified === file.lastModified,
          )
        )
          combined.push(file);
      return combined;
    });
  };
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = operations.busy ? "none" : "copy";
        if (!operations.busy) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        addFiles(Array.from(event.dataTransfer.files));
      }}
      onCancel={(event) => {
        if (operations.busy) event.preventDefault();
        else {
          onClose();
          navigate(subjectUrl(uploadSubject));
        }
      }}
      aria-labelledby="upload-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          if (!files.length) {
            setError("파일을 선택해 주세요.");
            return;
          }
          const invalid = files.find(
            (file) =>
              !/\.(pdf|txt|md)$/i.test(file.name) ||
              !file.size ||
              file.size > MAX_UPLOAD_BYTES,
          );
          if (invalid) {
            setError(
              `${invalid.name}: 비어 있지 않은 PDF, TXT, Markdown 파일을 선택해 주세요. 파일당 최대 ${MAX_UPLOAD_MIB} MiB입니다.`,
            );
            return;
          }
          void operations.run("자료를 업로드하고 있습니다.", async () => {
            const failed: File[] = [];
            const messages: string[] = [];
            for (const file of files) {
              try {
                await request(
                  `/api/analyses?filename=${encodeURIComponent(file.name)}&mode=${mode}&subjectId=${uploadSubject}`,
                  idSchema,
                  { method: "POST", body: file },
                );
              } catch (error) {
                failed.push(file);
                messages.push(`${file.name}: ${errorMessage(error)}`);
              }
            }
            await refresh(uploadSubject);
            if (failed.length) {
              setFiles(failed);
              setError(messages.join("\n"));
            } else {
              onClose();
              navigate(subjectUrl(uploadSubject));
            }
          });
        }}
      >
        <div className="dialog-heading">
          <h2 id="upload-title">학습 자료 추가</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="닫기"
            disabled={operations.busy}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="muted">
          학습 자료에서 개념과 관계를 찾아 지식 그래프에 연결합니다.
        </p>
        <fieldset id="upload-controls" disabled={operations.busy}>
          <label>
            과목
            <select
              required
              value={uploadSubject}
              onChange={(event) => setUploadSubject(event.target.value)}
            >
              {(
                workspace.data?.subjects ?? [
                  { id: subject.id, name: subject.name },
                ]
              ).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className={`drop-zone${dragging ? " dragging" : ""}`}>
            <span className="plus">+</span>
            <strong>
              {dragging
                ? "여기에 파일을 놓아 추가하세요"
                : "여러 파일을 놓거나 클릭하여 선택하세요"}
            </strong>
            <small>
              PDF · TXT · Markdown / 여러 파일 선택 가능 · 파일당 최대 {MAX_UPLOAD_MIB} MiB
            </small>
            <input
              type="file"
              multiple
              accept=".pdf,.txt,.md"
              onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
          </label>
          <p id="file-name" className="muted" role="status">
            {`${files.length}개 선택`}
          </p>
          {files.length > 0 && (
            <ul className="upload-file-list" aria-label="선택한 파일">
              {files.map((file) => (
                <li key={`${file.name}:${file.size}:${file.lastModified}`}>
                  <span>{file.name}</span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`${file.name} 제거`}
                    onClick={() => {
                      setFiles((previous) =>
                        previous.filter((item) => item !== file),
                      );
                      setError("");
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label>
            개념 정리 방식
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              <option value="conceptual">핵심 개념 · 원리와 구조 중심</option>
              <option value="detailed">세부 항목 · 자세한 개념 추출</option>
            </select>
          </label>
          <p className="muted small">
            PPT는 PDF로 내보낸 후 추가해 주세요. 이미지 기반 PDF는 Windows OCR로
            본문을 인식합니다.
          </p>
          <button className="primary full" type="submit">
            자료 추가 및 분석
          </button>
        </fieldset>
        {(error || operations.error) && (
          <p className="red" role="alert">
            {error || operations.error}
          </p>
        )}
      </form>
    </dialog>
  );
};

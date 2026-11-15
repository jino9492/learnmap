import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  errorMessage,
  idSchema,
  post,
  request,
  subjectUrl,
  workspaceSchema,
} from "../utils/api";
import { useOperations, useRefreshSubject } from "../hooks/useWorkspace";
import "./home.css";

const remembered = () => {
  try {
    return localStorage.getItem("learnmap.subjectId");
  } catch {
    return null;
  }
};

export const Home = () => {
  const workspace = useQuery({
    queryKey: ["workspace"],
    queryFn: () => request("/api/workspace", workspaceSchema),
  });
  const operations = useOperations();
  const refresh = useRefreshSubject();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [destination, setDestination] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState("conceptual");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const subjects = workspace.data?.subjects ?? [];
  const selected =
    subjects.find((item) => item.id === remembered()) ?? subjects[0];
  const target = destination ?? selected?.id ?? "new";

  useEffect(() => {
    document.title = "LearnMap · 학습 자료를 나만의 지식 지도로";
  }, []);

  const addFiles = (incoming: File[]) => {
    if (operations.busy) return;
    const invalid = incoming.find(
      (file) =>
        !/\.(pdf|txt|md)$/i.test(file.name) ||
        !file.size ||
        file.size > 20 * 1024 * 1024,
    );
    if (invalid) {
      setError(
        `${invalid.name}: 비어 있지 않은 PDF, TXT, Markdown 파일을 선택해 주세요. 파일당 최대 20 MiB입니다.`,
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

  // Preserve legacy bookmarks while showing the landing page on normal visits.
  const hash = window.location.hash;
  const legacyConcept = /^#concept\/(.+)$/.exec(hash);
  const legacyPage = (
    {
      "#map": "graph",
      "#path": "learning-path",
      "#history": "history",
    } as Record<string, string>
  )[hash];
  if (selected && (legacyConcept || legacyPage))
    return (
      <Navigate
        replace
        to={subjectUrl(
          selected.id,
          legacyConcept ? `concepts/${legacyConcept[1]}` : legacyPage,
        )}
      />
    );

  return (
    <div className="landing">
      <header className="landing-header">
        <Link className="landing-brand" to="/" aria-label="LearnMap 홈">
          <span className="landing-brand-mark" aria-hidden="true">
            ✳
          </span>
          LearnMap
        </Link>
        <nav aria-label="소개 페이지 메뉴">
          <a href="#how-it-works">이용 방법</a>
          <a href="#learning-preview">학습 지도 소개</a>
        </nav>
        {selected ? (
          <Link className="secondary compact" to={subjectUrl(selected.id)}>
            내 학습 공간 <span aria-hidden="true">↗</span>
          </Link>
        ) : (
          <a className="secondary compact" href="#start-learning">
            시작하기 ↗
          </a>
        )}
      </header>
      <main id="main" className="landing-main">
        <section className="landing-hero" aria-labelledby="landing-title">
          <p className="landing-eyebrow">자료에서 개념으로, 개념에서 이해로</p>
          <h1 id="landing-title">
            학습 자료를 <span>나만의 지식 지도</span>로
          </h1>
          <p className="landing-description">
            흩어져 있던 강의 자료를 한눈에 연결하세요.
            <br />
            AI가 핵심 개념과 관계를 정리하고, 다음에 배울 내용을 찾아줍니다.
          </p>
          <form
            id="start-learning"
            className="landing-upload"
            aria-label="학습 자료로 시작하기"
            aria-busy={operations.busy}
            onSubmit={(event) => {
              event.preventDefault();
              setError("");
              if (!files.length) {
                setError("분석할 파일을 먼저 선택해 주세요.");
                return;
              }
              if (target === "new" && !name.trim()) {
                setError("새 과목명을 입력해 주세요.");
                return;
              }
              void operations.run("자료를 업로드하고 있습니다.", async () => {
                let subjectId = target;
                if (target === "new") {
                  const subject = await post("/api/subjects", idSchema, {
                    name: name.trim(),
                  });
                  subjectId = subject.id;
                  setDestination(subjectId);
                  await workspace.refetch();
                }
                const failed: File[] = [];
                const messages: string[] = [];
                for (const file of files) {
                  try {
                    await request(
                      `/api/analyses?filename=${encodeURIComponent(file.name)}&mode=${mode}&subjectId=${encodeURIComponent(subjectId)}`,
                      idSchema,
                      { method: "POST", body: file },
                    );
                  } catch (failure) {
                    failed.push(file);
                    messages.push(`${file.name}: ${errorMessage(failure)}`);
                  }
                }
                await refresh(subjectId);
                if (failed.length) {
                  setFiles(failed);
                  setError(messages.join("\n"));
                } else navigate(subjectUrl(subjectId));
              });
            }}
          >
            <fieldset disabled={operations.busy}>
              <div
                className={`landing-dropzone${dragging ? " is-dragging" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (!operations.busy) setDragging(true);
                }}
                onDragLeave={(event) => {
                  if (
                    !event.currentTarget.contains(event.relatedTarget as Node)
                  )
                    setDragging(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  addFiles(Array.from(event.dataTransfer.files));
                }}
              >
                <svg
                  className="landing-file-icon"
                  width="56"
                  height="64"
                  viewBox="0 0 56 64"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M12 2h22l16 16v40a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4Z"
                    fill="white"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <path
                    d="M34 2v16h16M19 32h20M19 40h14M19 48h18"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <h2>
                  {dragging
                    ? "여기에 파일을 놓아주세요"
                    : "배우고 싶은 자료를 올려주세요"}
                </h2>
                <p>파일을 끌어 놓거나 아래 버튼으로 선택하세요.</p>
                <button
                  className="primary landing-file-button"
                  type="button"
                  onClick={() => input.current?.click()}
                >
                  <span aria-hidden="true">＋</span>{" "}
                  {files.length ? "파일 더 선택하기" : "파일 선택하기"}
                </button>
                <input
                  ref={input}
                  className="sr-only"
                  tabIndex={-1}
                  type="file"
                  aria-label="학습 자료 파일 선택"
                  accept=".pdf,.txt,.md"
                  multiple
                  onChange={(event) => {
                    addFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
                <small>
                  PDF · TXT · Markdown / 여러 파일 선택 가능 / 파일당 최대 20
                  MiB
                </small>
              </div>
              {files.length > 0 && (
                <ul className="landing-files" aria-label="선택한 파일">
                  {files.map((file, index) => (
                    <li key={`${file.name}:${file.size}:${file.lastModified}`}>
                      <span className="landing-file-type" aria-hidden="true">
                        {file.name.split(".").pop()}
                      </span>
                      <span className="landing-file-name">{file.name}</span>
                      <small>
                        {file.size < 1024 * 1024
                          ? `${Math.max(1, Math.round(file.size / 1024))} KB`
                          : `${(file.size / 1024 / 1024).toFixed(1)} MB`}
                      </small>
                      <button
                        type="button"
                        aria-label={`${file.name} 제거`}
                        onClick={() =>
                          setFiles((previous) =>
                            previous.filter((_, item) => item !== index),
                          )
                        }
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="landing-upload-settings">
                <label>
                  학습 공간
                  <select
                    value={target}
                    onChange={(event) => setDestination(event.target.value)}
                    disabled={workspace.isPending || workspace.isError}
                  >
                    {subjects.map((subject) => (
                      <option key={subject.id} value={subject.id}>
                        {subject.name}
                      </option>
                    ))}
                    <option value="new">새 과목으로 시작</option>
                  </select>
                </label>
                {target === "new" && (
                  <label>
                    과목명
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="예: 운영체제"
                      maxLength={80}
                      required
                    />
                  </label>
                )}
                <label>
                  개념 정리 방식
                  <select
                    value={mode}
                    onChange={(event) => setMode(event.target.value)}
                  >
                    <option value="conceptual">핵심 개념 중심</option>
                    <option value="detailed">세부 항목까지 자세히</option>
                  </select>
                </label>
              </div>
              <button
                className="primary landing-submit"
                type="submit"
                disabled={
                  !files.length || workspace.isPending || workspace.isError
                }
              >
                {operations.busy
                  ? "자료를 업로드하고 있습니다…"
                  : "학습 지도 만들기"}
                <span aria-hidden="true">→</span>
              </button>
            </fieldset>
            {error && (
              <p className="landing-upload-error" role="alert">
                {error}
              </p>
            )}
            {workspace.isPending && (
              <p className="muted" role="status">
                학습 공간을 불러오고 있습니다.
              </p>
            )}
            {workspace.isError && (
              <div className="landing-upload-error" role="alert">
                <p>{errorMessage(workspace.error)}</p>
                <button
                  type="button"
                  className="secondary compact"
                  onClick={() => void workspace.refetch()}
                >
                  다시 시도
                </button>
              </div>
            )}
            <p className="landing-upload-note">
              실행하면 내 학습 공간으로 이동해 분석 과정을 확인할 수 있습니다.
            </p>
          </form>
          <p className="landing-format-note">
            PPT 자료는 PDF로 내보낸 뒤 올려주세요. 이미지 기반 PDF도 본문을
            인식합니다.
          </p>
        </section>
        <section
          id="how-it-works"
          className="landing-how"
          aria-labelledby="how-title"
        >
          <p className="landing-eyebrow">HOW IT WORKS</p>
          <h2 id="how-title">자료 하나로 시작하는, 연결되는 공부</h2>
          <div className="landing-steps">
            {[
              [
                "01",
                "학습 자료 올리기",
                "강의 노트, 교재, 정리한 메모를 선택하세요. 여러 자료를 같은 과목에 모을 수 있습니다.",
              ],
              [
                "02",
                "개념의 연결 살펴보기",
                "AI가 정리한 핵심 개념과 선수 관계를 지도로 살펴보고, 원문 근거까지 확인하세요.",
              ],
              [
                "03",
                "이해하고, 다음으로",
                "개념별 문제로 이해도를 확인하고, 부족한 부분에 맞는 학습 경로를 따라가세요.",
              ],
            ].map(([number, title, description]) => (
              <article key={number}>
                <span className="landing-step-number">{number}</span>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </section>
        <section
          id="learning-preview"
          className="landing-preview"
          aria-labelledby="preview-title"
        >
          <div
            className="landing-graph-example"
            role="img"
            aria-label="운영체제에서 프로세스, 메모리 관리, 가상 메모리로 이어지는 학습 지도 예시"
          >
            <span className="landing-example-label">학습 지도 예시</span>
            <svg viewBox="0 0 500 300" aria-hidden="true">
              <g stroke="#bdcef1" strokeWidth="2" fill="none">
                <path d="M120 150C215 150 175 65 270 65M120 150C215 150 175 225 270 225M270 225C365 225 340 150 425 150" />
              </g>
              <g fill="white" stroke="#d5e0f5">
                <rect x="35" y="122" width="140" height="56" rx="16" />
                <rect x="210" y="37" width="130" height="56" rx="16" />
                <rect x="210" y="197" width="130" height="56" rx="16" />
                <rect x="363" y="122" width="126" height="56" rx="16" />
              </g>
              <rect
                x="35"
                y="122"
                width="140"
                height="56"
                rx="16"
                fill="#3b6eea"
              />
              <g
                fontSize="16"
                fontWeight="600"
                textAnchor="middle"
                dominantBaseline="central"
              >
                <text x="105" y="150" fill="white">
                  운영체제
                </text>
                <text x="275" y="65" fill="#34517b">
                  프로세스
                </text>
                <text x="275" y="225" fill="#34517b">
                  메모리 관리
                </text>
                <text x="426" y="150" fill="#34517b">
                  가상 메모리
                </text>
              </g>
            </svg>
          </div>
          <div className="landing-preview-copy">
            <p className="landing-eyebrow">YOUR LEARNING, CONNECTED</p>
            <h2 id="preview-title">
              읽고 지나간 내용이
              <br />
              서로 연결된 지식이 되도록.
            </h2>
            <p>
              무엇을 배웠는지, 어디부터 복습해야 할지.
              <br />
              나의 자료와 이해도를 한곳에서 살펴보세요.
            </p>
            <a href="#start-learning">
              내 자료로 시작하기 <span aria-hidden="true">↑</span>
            </a>
          </div>
        </section>
      </main>
      <footer className="landing-footer">
        <span>LearnMap</span>
        <p>나의 자료로 만드는, 나만의 학습 지도.</p>
        <a href="#start-learning">맨 위로 ↑</a>
      </footer>
    </div>
  );
};

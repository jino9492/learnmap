import { Navigate, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  errorMessage,
  idSchema,
  post,
  request,
  subjectUrl,
  workspaceSchema,
} from "../utils/api";
import { useOperations } from "../hooks/useWorkspace";
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
  const navigate = useNavigate();
  if (workspace.isPending)
    return <p role="status">학습 공간을 불러오고 있습니다.</p>;
  if (workspace.isError)
    return (
      <div role="alert">
        <p>{errorMessage(workspace.error)}</p>
        <button onClick={() => void workspace.refetch()}>다시 시도</button>
      </div>
    );
  const subjects = workspace.data.subjects;
  const selected =
    subjects.find((item) => item.id === remembered()) ?? subjects[0];
  if (selected) {
    const hash = window.location.hash;
    const legacyConcept = /^#concept\/(.+)$/.exec(hash);
    const legacyPage = (
      {
        "#map": "graph",
        "#path": "learning-path",
        "#history": "history",
      } as Record<string, string>
    )[hash];
    return (
      <Navigate
        replace
        to={subjectUrl(
          selected.id,
          legacyConcept
            ? `concepts/${legacyConcept[1]}`
            : (legacyPage ?? "graph"),
        )}
      />
    );
  }
  return (
    <section className="page-view">
      <div className="panel quiz-empty">
        <h1>첫 번째 학습 공간을 만들어 보세요</h1>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = new FormData(event.currentTarget).get("name");
            void operations.run("과목을 만들고 있습니다.", async () => {
              const subject = await post("/api/subjects", idSchema, { name });
              await workspace.refetch();
              navigate(subjectUrl(subject.id));
            });
          }}
        >
          <label>
            과목명
            <input
              name="name"
              maxLength={80}
              required
              placeholder="예: 운영체제"
            />
          </label>
          <button className="primary" disabled={operations.busy}>
            과목 만들기
          </button>
        </form>
      </div>
    </section>
  );
};

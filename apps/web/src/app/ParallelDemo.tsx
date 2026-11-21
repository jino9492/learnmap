import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { request, errorMessage, idSchema } from "../utils/api";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MIB,
} from "../../../shared/upload-limit.ts";
import "./parallel.css";

const fileSchema = z.object({
  name: z.string(),
  status: z.string(),
  stage: z.string(),
  percent: z.number(),
  completed: z.number().optional(),
  total: z.number().optional(),
  active: z.number(),
  waiting: z.number(),
  calls: z.number(),
  tokens: z.number(),
  warnings: z.number(),
  incomplete: z.boolean().optional(),
  error: z.string().optional(),
});
const userSchema = z.object({
  number: z.number(),
  files: z.array(fileSchema),
  graph: z.object({ concepts: z.number(), relations: z.number() }).nullable(),
});
const stateSchema = z.object({
  provider: z.string(),
  model: z.string(),
  fastModel: z.string(),
  maxUsers: z.number(),
  maxFiles: z.number(),
  run: z
    .object({
      id: z.string(),
      started: z.number(),
      ended: z.number().nullable(),
      error: z.string().optional(),
      stopping: z.boolean(),
      users: z.array(userSchema),
    })
    .nullable(),
});
type User = z.infer<typeof userSchema>;
const terminal = (status: string) =>
  ["ready", "failed", "cancelled"].includes(status);
const sum = (
  user: User,
  field: "active" | "waiting" | "calls" | "tokens" | "percent",
) => user.files.reduce((total, file) => total + file[field], 0);
function userStatus(user: User) {
  if (user.files.every((f) => terminal(f.status))) {
    if (user.files.some((f) => f.status === "cancelled")) return "중단";
    if (user.files.some((f) => f.status === "failed")) return "오류";
    return user.files.some((f) => f.incomplete) ? "일부 완료" : "완료";
  }
  if (sum(user, "waiting") && !sum(user, "active")) return "AI 대기";
  return user.files.every((f) => f.status === "queued")
    ? "시작 대기"
    : "분석 중";
}
const formatted = (value: number) => value.toLocaleString("ko-KR");

export function ParallelDemo() {
  const [files, setFiles] = useState<File[]>([]);
  const [users, setUsers] = useState("2");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const state = useQuery({
    queryKey: ["parallel-runs"],
    queryFn: () => request("/api/parallel-runs", stateSchema),
    refetchInterval: 1000,
    retry: false,
  });
  const run = state.data?.run;
  const running = !!run && !run.ended;
  const disabled = running || sending;
  const count = Number(users);
  const maxUsers = state.data?.maxUsers ?? 64;
  const maxFiles = state.data?.maxFiles ?? 8;
  function select(selected: File[]) {
    setError("");
    const next = [...files];
    for (const file of selected) {
      if (
        !file.size ||
        file.size > MAX_UPLOAD_BYTES ||
        !/\.(pdf|md|txt)$/i.test(file.name)
      ) {
        setError(
          `${file.name} · 비어 있지 않은 PDF, TXT, Markdown 파일을 ${MAX_UPLOAD_MIB} MiB 이내로 선택하세요.`,
        );
        return;
      }
      if (
        !next.some(
          (f) =>
            f.name === file.name &&
            f.size === file.size &&
            f.lastModified === file.lastModified,
        )
      )
        next.push(file);
    }
    if (next.length > maxFiles) {
      setError(`파일은 최대 ${maxFiles}개까지 선택할 수 있습니다.`);
      return;
    }
    setFiles(next);
  }
  async function submit(stop = false) {
    if (sending) return;
    setSending(true);
    setError("");
    try {
      if (stop && run)
        await request(`/api/parallel-runs/${run.id}/stop`, z.object({}), {
          method: "POST",
        });
      else {
        const form = new FormData();
        form.set("users", users);
        files.forEach((file) => form.append("files", file));
        await request("/api/parallel-runs", idSchema, {
          method: "POST",
          body: form,
        });
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      await state.refetch();
      setSending(false);
    }
  }
  const rows = run?.users ?? [];
  const complete = rows.filter((u) => userStatus(u) === "완료").length;
  return (
    <main className="parallel-page">
      <header>
        <span className="parallel-brand">LearnMap</span>
        <span>AI 실험실</span>
      </header>
      <h1>그래프 병렬 분석</h1>
      <p>
        같은 파일 묶음으로 여러 사용자가 동시에 그래프를 생성하는 과정을
        확인하세요.
      </p>
      <section className="parallel-setup" aria-label="실험 설정">
        <div>
          <h2>학습 자료 묶음</h2>
          <button
            className="parallel-picker"
            disabled={disabled}
            onClick={() => picker.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!disabled) select(Array.from(e.dataTransfer.files));
            }}
          >
            파일 선택 또는 끌어 놓기{" "}
            <small>PDF · TXT · Markdown / 파일당 {MAX_UPLOAD_MIB} MiB</small>
          </button>
          <input
            ref={picker}
            hidden
            type="file"
            multiple
            accept=".pdf,.txt,.md"
            onChange={(e) => {
              select(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          {files.length > 0 && (
            <ul className="parallel-files">
              {files.map((f, i) => (
                <li key={i}>
                  {f.name}{" "}
                  <button
                    disabled={disabled}
                    aria-label={f.name + " 제거"}
                    onClick={() => setFiles(files.filter((_, n) => n !== i))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <label htmlFor="parallel-users">가상 사용자 수</label>
          <input
            id="parallel-users"
            type="number"
            min={1}
            max={maxUsers}
            value={users}
            disabled={disabled}
            onChange={(e) => setUsers(e.target.value)}
          />
          <p>
            파일 {files.length}개 × 사용자{" "}
            {Number.isInteger(count) && count > 0 ? count : 0}명. 각 사용자가
            자료 전체를 독립적으로 분석합니다.
          </p>
          <button
            className="primary"
            disabled={
              disabled ||
              !state.isSuccess ||
              !files.length ||
              !Number.isInteger(count) ||
              count < 1 ||
              count > maxUsers
            }
            onClick={() => void submit()}
          >
            {sending ? "요청 중…" : "실제 API로 분석 시작"}
          </button>
        </div>
      </section>
      <p className="parallel-provider">
        공급자 {state.data?.provider ?? "조회 중"} ·{" "}
        {[
          ...new Set(
            [state.data?.model, state.data?.fastModel].filter(Boolean),
          ),
        ].join(" / ")}{" "}
        · 분석 캐시를 끄고 실행하며 사용자 수에 따라 API 비용이 발생합니다.
      </p>
      {error && <p role="alert">{error}</p>}
      {state.isError && (
        <p role="alert">
          실험 서버 연결을 확인하세요. npm run queue:demo로 실행한 서버에서
          상태를 다시 조회합니다.
        </p>
      )}
      <section className="parallel-results">
        <div className="parallel-heading">
          <h2>사용자별 진행 현황</h2>
          {running && (
            <button
              disabled={sending || run.stopping}
              onClick={() => void submit(true)}
            >
              {run.stopping ? "중단 중…" : "실험 중단"}
            </button>
          )}
        </div>
        {run?.error && <p role="alert">{run.error}</p>}
        {!run ? (
          <p>
            분석을 시작하면 사용자별 그래프와 파일 진행률이 여기에 표시됩니다.
          </p>
        ) : (
          <>
            <div className="parallel-stats">
              {[
                ["그래프 완료", `${complete} / ${rows.length}`],
                [
                  "일부 완료",
                  rows.filter((u) => userStatus(u) === "일부 완료").length,
                ],
                [
                  "실행 중인 AI 호출",
                  rows.reduce((n, u) => n + sum(u, "active"), 0),
                ],
                [
                  "큐 대기 호출",
                  rows.reduce((n, u) => n + sum(u, "waiting"), 0),
                ],
                [
                  "경과 시간",
                  Math.max(
                    0,
                    Math.floor(
                      ((run.ended ?? Date.now()) - run.started) / 1000,
                    ),
                  ) + "초",
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <div className="parallel-table">
              <table>
                <thead>
                  <tr>
                    {[
                      "사용자 / 상태",
                      "그래프 진행률",
                      "실행 / 대기",
                      "성공 호출",
                      "보고 토큰",
                      "결과",
                    ].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <UserRows key={run.id + u.number} user={u} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
function UserRows({ user: u }: { user: User }) {
  const [expanded, setExpanded] = useState(false);
  const percent = Math.floor(sum(u, "percent") / u.files.length);
  const current = u.files.find(
    (f) => !terminal(f.status) && f.status !== "queued",
  );
  return (
    <>
      <tr>
        <td>
          <button
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "▾" : "▸"} 사용자 {u.number}
          </button>
          <small>{userStatus(u)}</small>
        </td>
        <td>
          <strong>{percent}%</strong>
          <progress
            value={percent}
            max={100}
            aria-label={`사용자 ${u.number} 진행률`}
          />
          <small>
            {current
              ? `${current.name} · ${current.stage}`
              : `파일 ${u.files.filter((f) => f.status === "ready").length}/${u.files.length} 완료`}
          </small>
        </td>
        <td>
          {sum(u, "active")} / {sum(u, "waiting")}
        </td>
        <td>{formatted(sum(u, "calls"))}</td>
        <td>{formatted(sum(u, "tokens"))}</td>
        <td>
          {u.graph
            ? `개념 ${u.graph.concepts} · 관계 ${u.graph.relations}`
            : "—"}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6}>
            <ul className="parallel-details">
              {u.files.map((f, i) => (
                <li key={i}>
                  <b>{f.name}</b>
                  <span>
                    {f.status === "cancelled" ? "중단" : f.stage} · {f.percent}%{" "}
                    {f.total ? `· ${f.completed}/${f.total}묶음` : ""}
                  </span>
                  {f.error && <span>{f.error}</span>}
                  {f.incomplete && <span>파일 간 관계 일부 미완료</span>}
                  {f.warnings > 0 && <span>경고 {f.warnings}건</span>}
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

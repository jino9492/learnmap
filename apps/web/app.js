import { createApiClient, createAnalysisPoller } from "/api.js";
import { createGraph, statusLabels, statusColors } from "/graph.js";

const $ = (id) => document.getElementById(id);
const request = createApiClient();
const state = { subjects: [], subject: null, selectedId: null, query: "", filter: "ALL", busy: false, analysisId: null, question: null, submitted: false, deleteId: null };
let loadVersion = 0;
let questionNumber = 0;

function node(tag, attributes = {}, ...children) {
  const item = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("on")) item.addEventListener(key.slice(2), value);
    else if (key === "className") item.className = value;
    else if (value !== undefined && value !== null) item.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child !== undefined && child !== null) item.append(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  return item;
}
function pill(text, color = "neutral") { return node("span", { className: `pill ${color}` }, text); }
function button(text, className, action, disabled = false) {
  const item = node("button", { type: "button", className, onclick: action }, text);
  item.disabled = disabled;
  return item;
}
function remember(id) { try { localStorage.setItem("learnmap.subjectId", id); } catch { /* Storage is optional for navigation. */ } }
function remembered() { try { return localStorage.getItem("learnmap.subjectId"); } catch { return null; } }
function clearError() { $("error").hidden = true; document.querySelectorAll(".dialog-error").forEach((item) => item.remove()); }
function reportError(error) {
  const messages = { CONFIG: "AI 연결 설정을 확인해 주세요. 서버의 .env에 공급자와 모델을 설정한 뒤 다시 시도할 수 있습니다.", TIMEOUT: "AI 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.", INTERNAL: "요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.", INPUT: "자료 또는 입력 내용을 확인해 주세요. PDF는 텍스트를 포함해야 하며 파일은 20 MiB 이하여야 합니다.", DEMO_CONNECTION: "서버에 연결할 수 없습니다. 연결을 확인한 뒤 다시 시도해 주세요." };
  const message = messages[error.code] ?? (/^[\x00-\x7F]*$/.test(error.message ?? "") ? "요청을 완료하지 못했습니다. 서버 연결과 AI 설정을 확인해 주세요." : error.message);
  $("error").replaceChildren(node("span", {}, message), button("닫기", "compact", clearError));
  $("error").hidden = false;
  const dialog = document.querySelector("dialog[open]");
  if (dialog) { dialog.querySelectorAll(".dialog-error").forEach((item) => item.remove()); dialog.append(node("p", { className: "dialog-error red", role: "alert" }, message)); }
}
function notify(message) { $("notice").replaceChildren(node("span", {}, message), button("닫기", "compact", () => { $("notice").hidden = true; })); $("notice").hidden = false; }
function controls() {
  $("upload-controls").disabled = state.busy || Boolean(state.analysisId);
  $("question-controls").disabled = state.busy || !selected();
  $("answer-controls").disabled = state.busy || !state.question;
  $("answer").disabled = state.submitted;
  document.querySelectorAll("input[name=answer-option]").forEach((item) => { item.disabled = state.submitted; });
  $("submit-answer").disabled = state.busy || state.submitted;
  document.querySelectorAll(".subject-item").forEach((item) => { item.disabled = state.busy; });
  document.querySelectorAll("[data-learning]").forEach((item) => { item.disabled = state.busy || !selected(); });
}
async function perform(message, action) {
  if (state.busy) return;
  state.busy = true; clearError(); notify(message); render();
  try { await action(); if ($("notice").firstElementChild?.textContent === message) $("notice").hidden = true; }
  catch (error) { $("notice").hidden = true; reportError(error); }
  finally { state.busy = false; render(); }
}
const selected = () => state.subject?.graph.concepts.find((concept) => concept.id === state.selectedId);
const progressFor = (id) => state.subject?.progress.find((item) => item.conceptId === id);
const mastery = (id) => progressFor(id)?.status ?? "NOT_STARTED";
const scoreLabel = (id) => progressFor(id) ? `${progressFor(id).score}%` : "아직 평가 전";
const section = (title, ...content) => node("div", { className: "detail-section" }, node("h3", {}, title), ...content);

function selectConcept(id) {
  if (state.busy || id === state.selectedId) return;
  state.selectedId = id;
  resetQuestion(); renderMap(); renderQuizInfo();
}
const graph = createGraph($("graph"), selectConcept);
$("zoom-in").addEventListener("click", () => graph.zoom(1 / 1.2));
$("zoom-out").addEventListener("click", () => graph.zoom(1.2));
$("fit").addEventListener("click", graph.fit);

function sourceCard(concept) {
  const [materialId, location] = concept.sourceLocation.split("/");
  const material = state.subject.materials.find((item) => item.id === materialId);
  const page = /page:(\d+)/.exec(location ?? "")?.[1];
  return node("a", { className: "source-card", href: `/api/materials/${materialId}/file${page ? `#page=${page}` : ""}`, target: "_blank", rel: "noopener" }, material?.title ?? "원본 자료", node("small", {}, page ? `p. ${page} · 원본 보기 ↗` : "원본 자료 보기 ↗"));
}
function sourceCards(concept) {
  const sources = new Map([concept, ...(concept.citations ?? [])].map((citation) => [citation.sourceLocation, citation]));
  return [...sources.values()].map(sourceCard);
}
function prerequisites(concept) {
  const ids = new Set(state.subject.graph.relations.filter((relation) => relation.type === "PREREQUISITE" && relation.target === concept.id).map((relation) => relation.source));
  const concepts = state.subject.graph.concepts.filter((item) => ids.has(item.id));
  return concepts.length ? node("div", { className: "tags" }, concepts.map((item) => button(item.name, `pill ${statusColors[mastery(item.id)]}`, () => { selectConcept(item.id); location.hash = "map"; }, state.busy))) : node("p", {}, "등록된 선수 개념이 없습니다.");
}
function renderSubjects() {
  $("subjects").replaceChildren(...state.subjects.map((subject) => button("", `subject-item${subject.id === state.subject?.id ? " selected" : ""}`, () => void switchSubject(subject.id))));
  [...$("subjects").children].forEach((item, index) => { const subject = state.subjects[index]; item.append(node("strong", {}, subject.name), node("small", {}, `${subject.conceptCount}개 개념`)); item.setAttribute("aria-pressed", String(subject.id === state.subject?.id)); });
  $("upload-subject").replaceChildren(...state.subjects.map((subject) => node("option", { value: subject.id }, subject.name)));
  if (state.subject) $("upload-subject").value = state.subject.id;
  $("subject-pill").textContent = state.subject?.name ?? "학습 공간";
  controls();
}
const materialStatus = { queued: "분석 대기", extracting_text: "텍스트 추출 중", extracting_concepts: "개념 추출 중", organizing_concepts: "개념 정리 중", analyzing_relations: "관계 분석 중", localizing: "한국어 정리 중", failed: "분석 실패 · 다시 분석할 수 있습니다", ready: "분석 완료" };
function renderMaterials() {
  const materials = state.subject?.materials ?? [];
  $("toggle-materials").textContent = `자료 관리 · ${materials.length}개`;
  $("materials").replaceChildren(...materials.map((material) => {
    const pending = !["ready", "failed"].includes(material.status);
    const actions = node("div", { className: "material-actions" }, button("↻", "", () => void reanalyze(material.id), state.busy || pending || Boolean(state.analysisId)), button("×", "", () => { state.deleteId = material.id; $("delete-description").textContent = `‘${material.title}’ 자료를 삭제하시겠습니까?`; $("delete-dialog").showModal(); }, state.busy || pending));
    actions.children[0].setAttribute("aria-label", `${material.title} 다시 분석`);
    actions.children[1].setAttribute("aria-label", `${material.title} 삭제`);
    return node("div", { className: "material-item" }, node("a", { className: "material-name", href: `/api/materials/${material.id}/file`, target: "_blank", rel: "noopener", title: material.title }, material.title), actions, node("small", {}, material.error ? "분석 오류 · 다시 분석해 주세요" : materialStatus[material.status]));
  }));
  if (!materials.length) $("materials").append(node("p", { className: "muted small" }, "아직 추가한 자료가 없습니다."));
}
function renderMap() {
  const subject = state.subject;
  if (!subject) return;
  $("map-title").textContent = `${subject.name} 지식 그래프`;
  $("graph-summary").textContent = `자료 ${subject.materials.length}개 · 개념 ${subject.graph.concepts.length}개 · 연결 ${subject.graph.relations.length}개`;
  const count = graph.render({ graphId: subject.id, name: subject.name, ...subject.graph, progress: subject.progress, selectedId: state.selectedId, path: subject.path, query: state.query, filter: state.filter });
  $("graph-count").textContent = `${count}개 개념 표시`;
  $("graph-empty").hidden = subject.graph.concepts.length > 0;
  if (!count && subject.graph.concepts.length) $("graph-count").textContent = "검색 또는 필터와 일치하는 개념이 없습니다.";
  const counts = { MASTERED: 0, REVIEW_REQUIRED: 0, WEAK: 0 };
  for (const concept of subject.graph.concepts) { const status = mastery(concept.id); if (status in counts) counts[status]++; }
  $("stats").replaceChildren(pill(`이해 완료 ${counts.MASTERED}`, "green"), pill(`복습 필요 ${counts.REVIEW_REQUIRED}`, "amber"), pill(`이해 부족 ${counts.WEAK}`, "red"));
  const concept = selected();
  if (!concept) { $("concept-detail").replaceChildren(node("h2", {}, "개념 살펴보기"), node("p", { className: "empty-detail" }, "그래프에서 개념을 선택하면 설명과 선수 개념, 관련 학습 자료를 확인할 수 있습니다.")); return; }
  const progress = progressFor(concept.id);
  const meter = node("progress", { max: 100, value: progress?.score ?? 0, "aria-label": "현재 이해도" });
  const quizButton = button("이 개념 문제 풀기", "primary full", openQuiz, state.busy);
  const pathButton = button("추천 학습 경로 보기", "secondary full", () => void generatePath(), state.busy);
  quizButton.dataset.learning = ""; pathButton.dataset.learning = "";
  $("concept-detail").replaceChildren(node("h2", {}, concept.name), pill(statusLabels[mastery(concept.id)], statusColors[mastery(concept.id)]), section("현재 이해도", node("div", { className: "score" }, scoreLabel(concept.id)), meter), section("개념 설명", node("p", {}, concept.description)), section("선수 개념", prerequisites(concept)), section("관련 자료", ...sourceCards(concept)), node("div", { className: "detail-actions" }, quizButton, pathButton));
}
function renderQuizInfo() {
  const concept = selected();
  $("quiz-title").textContent = concept ? `${concept.name} · 이해도 평가` : "개념 이해도 평가";
  if (!concept) { $("quiz-info").replaceChildren(node("h2", {}, "학습 정보"), node("p", { className: "muted" }, "먼저 지식 그래프에서 개념을 선택해 주세요.")); return; }
  $("quiz-info").replaceChildren(node("h2", {}, "학습 정보"), node("p", { className: "eyebrow" }, "평가 대상 개념"), node("p", { className: "info-name" }, concept.name), pill(`현재 이해도 ${scoreLabel(concept.id)}`, "blue"), node("div", { className: "divider" }), section("선수 개념", prerequisites(concept)), section("참고 학습 자료", ...sourceCards(concept)), section("학습 안내", node("p", {}, "제출 후 AI가 개념 이해도와 오개념을 분석합니다. 평가 결과는 지식 그래프에 자동 반영됩니다.")));
}
function renderPath() {
  const subject = state.subject;
  if (!subject) return;
  const steps = subject.path?.steps ?? [];
  $("path-tags").replaceChildren(pill(subject.name, "blue"), pill(`${steps.length}개 개념`));
  $("path-steps").replaceChildren(...steps.map((step, index) => {
    const concept = subject.graph.concepts.find((item) => item.id === step.conceptId);
    const item = button("", `path-step${index === 0 ? " selected" : ""}`, () => { selectConcept(step.conceptId); openQuiz(); }, state.busy);
    item.title = step.reason;
    item.append(node("span", { className: "step-number" }, index + 1), node("strong", {}, concept?.name ?? "개념"), pill(statusLabels[mastery(step.conceptId)], statusColors[mastery(step.conceptId)]));
    return item;
  }));
  if (!steps.length) $("path-steps").append(node("div", { className: "quiz-empty" }, node("p", {}, "아직 추천 경로가 없습니다."), button("선택한 개념으로 경로 생성", "secondary", () => void generatePath(), !selected() || state.busy)));
  $("path-reason").textContent = subject.path?.possibleCause ?? "그래프에서 목표 개념을 선택하면 선수 관계와 누적 풀이 기록을 바탕으로 학습 순서를 제안합니다.";
  const mastered = subject.progress.filter((item) => item.status === "MASTERED").length;
  const weak = subject.progress.filter((item) => item.status !== "MASTERED").sort((a,b) => a.score - b.score);
  $("path-progress").replaceChildren(node("h2", {}, "학습 진행"), section("이해 완료", node("div", { className: "score" }, `${mastered} / ${subject.graph.concepts.length} 개념`), node("progress", { max: Math.max(1,subject.graph.concepts.length), value: mastered, "aria-label": "이해 완료 개념 비율" })), section("취약 개념", weak.length ? node("div", {}, weak.slice(0,4).map((item) => {
    const concept = subject.graph.concepts.find((entry) => entry.id === item.conceptId);
    return node("div", { className: `weak-card ${statusColors[item.status]}` }, node("div", {}, node("strong", {}, concept?.name ?? "삭제된 개념"), node("small", {}, `이해도 ${item.score}%`)), pill(item.status === "WEAK" ? "우선" : "복습", statusColors[item.status]));
  })) : node("p", { className: "muted" }, "문제 풀이 후 취약 개념을 확인할 수 있습니다.")), section("추천 경로", node("div", { className: "score" }, `${steps.length}개 개념`)), button("학습 시작", "primary", () => { selectConcept(steps[0]?.conceptId); openQuiz(); }, !steps.length || state.busy), node("p", { className: "small" }, "문제를 풀면 누적 이해도가 자동으로 갱신됩니다."));
}
function renderHistory() {
  const history = state.subject?.history ?? [];
  $("history-list").replaceChildren(...history.slice().reverse().map((entry) => node("article", { className: "panel history-card" }, node("header", {}, node("h3", {}, entry.conceptName), node("time", { datetime: entry.createdAt }, new Date(entry.createdAt).toLocaleString("ko-KR"))), pill(entry.status === "FAILED" ? "평가 실패" : entry.status === "PENDING" ? "평가 중" : `${entry.score}점`, entry.score >= 80 ? "green" : entry.score >= 50 ? "amber" : "red"), node("p", {}, entry.question), node("p", { className: "muted" }, entry.feedback ?? "답안 평가를 진행하고 있습니다."), node("details", {}, node("summary", {}, "제출한 답안 보기"), node("p", {}, entry.answer)))));
  if (!history.length) $("history-list").append(node("div", { className: "panel quiz-empty" }, node("h2", {}, "첫 번째 학습을 시작해 보세요"), node("p", {}, "개념별 문제를 풀면 평가와 피드백이 여기에 쌓입니다."), button("지식 그래프 보기", "secondary", () => { location.hash = "map"; })));
}
function render() { renderSubjects(); renderMaterials(); renderMap(); renderPath(); renderQuizInfo(); renderHistory(); controls(); }
async function refreshSubjects() { state.subjects = (await request("/api/workspace")).subjects; }
async function loadSubject(id) {
  const version = ++loadVersion;
  const subject = await request(`/api/subjects/${id}`);
  if (version !== loadVersion) return;
  if (state.subject?.id !== subject.id) { state.selectedId = null; resetQuestion(); }
  state.subject = subject;
  if (!subject.graph.concepts.some((concept) => concept.id === state.selectedId)) state.selectedId = subject.graph.concepts[0]?.id ?? null;
  remember(id); await refreshSubjects(); render();
}
async function switchSubject(id) {
  if (state.busy || id === state.subject?.id) return;
  await perform("학습 공간을 불러오고 있습니다.", async () => { state.selectedId = null; state.query = ""; state.filter = "ALL"; $("search").value = ""; updateFilters(); resetQuestion(); await loadSubject(id); location.hash = "map"; });
}
function updateFilters() { document.querySelectorAll("[data-filter]").forEach((item) => { const active = item.dataset.filter === state.filter; item.classList.toggle("active", active); item.setAttribute("aria-pressed", String(active)); }); }
$("search").addEventListener("input", (event) => { state.query = event.target.value; renderMap(); });
$("filters").addEventListener("click", (event) => { const filter = event.target.closest("[data-filter]")?.dataset.filter; if (filter) { state.filter = filter; updateFilters(); renderMap(); } });
function route() {
  const view = ["map", "path", "quiz", "history"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "map";
  for (const name of ["map", "path", "quiz", "history"]) $(`${name}-view`).hidden = name !== view;
  $("workspace").classList.toggle("wide", view !== "map");
  document.querySelectorAll("nav a").forEach((link) => { if (link.hash === `#${view}`) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current"); });
  const titles = { map: "나의 학습 지도", path: "개인화 학습 경로", quiz: "개념 이해도 평가", history: "나의 학습 기록" };
  document.title = `LearnMap · ${titles[view]}`;
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", route);
document.querySelectorAll("[data-back]").forEach((item) => item.addEventListener("click", () => { location.hash = "map"; }));
document.querySelectorAll("[data-close]").forEach((item) => item.addEventListener("click", () => { item.closest("dialog").close(); }));
document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } }));
document.querySelectorAll("[data-upload]").forEach((item) => item.addEventListener("click", () => { clearError(); $("upload-dialog").showModal(); }));
$("add-subject").addEventListener("click", () => { $("subject-dialog").showModal(); });
$("toggle-materials").addEventListener("click", () => { const open = $("material-section").classList.toggle("is-open"); $("toggle-materials").setAttribute("aria-expanded", String(open)); });
$("subject-form").addEventListener("submit", (event) => {
  event.preventDefault(); const name = $("subject-name").value.trim(); if (!name) return;
  void perform("과목을 만들고 있습니다.", async () => {
    const subject = await request("/api/subjects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    state.selectedId = null; resetQuestion(); await loadSubject(subject.id); $("subject-form").reset(); $("subject-dialog").close(); location.hash = "map";
  });
});
$("material-file").addEventListener("change", () => { $("file-name").textContent = $("material-file").files[0]?.name ?? ""; });
for (const name of ["dragenter", "dragover"]) $("drop-zone").addEventListener(name, (event) => { event.preventDefault(); $("drop-zone").classList.add("dragging"); });
for (const name of ["dragleave", "drop"]) $("drop-zone").addEventListener(name, (event) => { event.preventDefault(); $("drop-zone").classList.remove("dragging"); });
$("drop-zone").addEventListener("drop", (event) => { if (event.dataTransfer.files.length) { $("material-file").files = event.dataTransfer.files; $("file-name").textContent = event.dataTransfer.files[0].name; } });

const stages = ["queued", "extracting_text", "extracting_concepts", "organizing_concepts", "analyzing_relations", "localizing", "ready"];
const poller = createAnalysisPoller({ request, shouldContinue: (snapshot) => !["ready", "failed"].includes(snapshot.status),
  onState(snapshot) {
    $("analysis-status").textContent = materialStatus[snapshot.status] ?? "분석 중";
    $("analysis-progress").value = Math.max(2, stages.indexOf(snapshot.status) / (stages.length - 1) * 100);
    if (["ready", "failed"].includes(snapshot.status)) {
      state.analysisId = null; $("analysis-banner").hidden = true; controls();
      if (snapshot.error) reportError(snapshot.error);
      else notify(snapshot.localization?.warning ?? "분석을 완료했습니다. 개념을 선택해 학습을 시작하세요.");
      if (state.subject) void loadSubject(state.subject.id).catch(reportError);
    }
  },
  onConnectionError(error, delay) { $("analysis-status").textContent = `연결 재시도 중 · ${delay / 1000}초 후 자동으로 확인합니다.`; },
  onFatalError(error) { state.analysisId = null; $("analysis-banner").hidden = true; controls(); reportError(error); },
});
function trackAnalysis(id) { state.analysisId = id; $("analysis-banner").hidden = false; $("analysis-status").textContent = "분석 대기 중"; $("analysis-progress").value = 0; controls(); void poller.start(id); }
$("reconnect").addEventListener("click", () => void poller.refresh());
$("upload-form").addEventListener("submit", (event) => {
  event.preventDefault(); const file = $("material-file").files[0]; if (!file || state.analysisId) return;
  if (!/\.(pdf|txt|md)$/i.test(file.name) || !file.size || file.size > 20 * 1024 * 1024) { reportError({ code: "INPUT" }); return; }
  const subjectId = $("upload-subject").value;
  void perform("학습 자료를 업로드하고 있습니다.", async () => {
    const result = await request(`/api/analyses?filename=${encodeURIComponent(file.name)}&mode=${$("concept-mode").value}&subjectId=${subjectId}`, { method: "POST", body: file });
    await loadSubject(subjectId); $("upload-dialog").close(); $("upload-form").reset(); $("file-name").textContent = ""; location.hash = "map"; trackAnalysis(result.id);
  });
});
async function reanalyze(id) { await perform("자료를 다시 분석합니다.", async () => { const result = await request(`/api/materials/${id}/analyze`, { method: "POST" }); trackAnalysis(result.id); }); }
$("delete-form").addEventListener("submit", (event) => {
  event.preventDefault(); if (!state.deleteId) return;
  void perform("자료를 삭제하고 있습니다.", async () => { await request(`/api/materials/${state.deleteId}`, { method: "DELETE" }); $("delete-dialog").close(); resetQuestion(); await loadSubject(state.subject.id); });
});
function resetQuestion() {
  state.question = null; state.submitted = false;
  $("question-body").hidden = true; $("question-empty").hidden = false; $("evaluation").hidden = true; $("answer").value = ""; $("answer-options").replaceChildren(); controls();
}
function openQuiz() { if (!selected()) return; renderQuizInfo(); location.hash = "quiz"; $("question-type").focus(); }
async function post(action, input) { return request(`/api/analyses/${state.subject.id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }); }
$("question-form").addEventListener("submit", (event) => {
  event.preventDefault(); if (!selected()) return;
  void perform("학습 자료를 바탕으로 문제를 생성하고 있습니다.", async () => {
    const result = await post("questions", { conceptId: state.selectedId, type: $("question-type").value, difficulty: $("difficulty").value });
    resetQuestion(); state.question = result; questionNumber++;
    $("question-text").textContent = result.question.question;
    $("question-number").textContent = `문제 ${questionNumber}`;
    $("quiz-progress-label").textContent = "답변 대기 중"; $("quiz-progress").value = 0;
    $("quiz-type-label").textContent = { ESSAY: "서술형", SHORT_ANSWER: "단답형", MULTIPLE_CHOICE: "객관식" }[result.question.type];
    const multiple = result.question.type === "MULTIPLE_CHOICE";
    $("written-answer").hidden = multiple; $("answer").required = !multiple;
    if (multiple) $("answer-options").replaceChildren(...result.question.options.map((option, index) => node("label", { className: "choice" }, node("input", { type: "radio", name: "answer-option", value: option, required: "", id: `option-${index}` }), node("span", {}, option))));
    $("question-body").hidden = false; $("question-empty").hidden = true;
    if (result.localization?.warning) notify(result.localization.warning);
  });
});
$("answer-form").addEventListener("submit", (event) => {
  event.preventDefault(); if (!state.question || state.submitted) return;
  const answer = state.question.question.type === "MULTIPLE_CHOICE" ? document.querySelector("input[name=answer-option]:checked")?.value : $("answer").value.trim();
  if (!answer) return;
  void perform("답안의 개념 이해도를 분석하고 있습니다.", async () => {
    const result = await post("evaluations", { questionId: state.question.questionId, answer });
    state.submitted = true;
    $("quiz-progress-label").textContent = "평가 완료"; $("quiz-progress").value = 100;
    $("evaluation").hidden = false;
    $("evaluation").replaceChildren(node("h3", {}, "이번 문제 평가"), node("div", { className: "score" }, `${result.evaluation.score}점`), node("p", {}, result.evaluation.feedback), node("p", { className: "muted small" }, "개념 이해도는 최근 최대 5회 평가 점수의 평균으로 계산합니다."), button("추천 학습 경로 보기", "secondary", () => void generatePath()));
    await loadSubject(state.subject.id);
    if (result.localization?.warning) notify(result.localization.warning);
    $("evaluation").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
});
async function generatePath() {
  if (!selected()) { location.hash = "map"; notify("먼저 그래프에서 목표 개념을 선택해 주세요."); return; }
  await perform("선수 관계와 학습 기록을 분석하고 있습니다.", async () => { const result = await post("path", { conceptId: state.selectedId }); await loadSubject(state.subject.id); location.hash = "path"; if (result.localization?.warning) notify(result.localization.warning); });
}
$("show-path").addEventListener("click", () => { location.hash = "path"; });

async function initialize() {
  route();
  await refreshSubjects();
  if (!state.subjects.length) { await request("/api/subjects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "운영체제" }) }); await refreshSubjects(); }
  const id = state.subjects.find((subject) => subject.id === remembered())?.id ?? state.subjects[0].id;
  await loadSubject(id);
  const pending = state.subject.materials.find((material) => !["ready", "failed"].includes(material.status));
  if (pending) trackAnalysis(pending.id);
}
void initialize().catch(reportError);

import { createApiClient, createAnalysisPoller } from "./api.js";

const element = (id) => document.getElementById(id);
const showJson = (id, value) => { element(id).textContent = JSON.stringify(value, null, 2); };
let analysisId;
let question;
let ready = false;
let busy = false;
let analyzing = false;
let serverBusy = false;
let connectionLost = false;
const request = createApiClient();
const storageKey = "learnmap.demo.analysisId";

function saveAnalysis(id) {
  try {
    if (id) sessionStorage.setItem(storageKey, id);
    else sessionStorage.removeItem(storageKey);
  } catch { /* The demo also works when browser storage is unavailable. */ }
}

function savedAnalysis() {
  try {
    const value = sessionStorage.getItem(storageKey);
    return /^[a-f0-9-]{36}$/.test(value ?? "") ? value : undefined;
  } catch { return undefined; }
}

function controls() {
  const blocked = busy || analyzing || serverBusy || connectionLost;
  element("upload-controls").disabled = blocked;
  element("learning-controls").disabled = blocked || !ready;
  element("answer-controls").disabled = blocked || !ready || !question;
  element("reconnect").disabled = !analysisId;
}

function render(state) {
  const wasAnalyzing = analyzing;
  analyzing = !["ready", "failed"].includes(state.status);
  serverBusy = state.busy;
  connectionLost = false;
  element("connection-status").textContent = "";
  ready = state.status === "ready";
  const progress = state.events.filter((event) => event.kind === "progress").at(-1);
  const labels = { queued: "대기 중", extracting_text: "PDF 텍스트 추출 중", extracting_concepts: "개념 추출 중", organizing_concepts: "핵심 개념 정리 중", analyzing_relations: "관계 분석 중", ready: "분석 완료", failed: "분석 실패" };
  element("analysis-status").textContent = `${labels[state.status] ?? state.status}${progress ? ` (${progress.completed}/${progress.total} 묶음)` : ""}`;
  showJson("events", state.events);
  showJson("analysis-result", { mode: state.mode, material: state.material, graph: state.graph, detailedConcepts: state.detailedConcepts, error: state.error });
  if (state.error) element("error").textContent = `${state.error.code}: ${state.error.message}`;
  if (ready && !element("concept").options.length) {
    element("concept-mode").value = state.mode ?? "detailed";
    for (const concept of state.graph.concepts) {
      const option = document.createElement("option");
      option.value = concept.id;
      option.textContent = `${concept.id} — ${concept.name}`;
      element("concept").append(option);
    }
  }
  if (!analyzing && wasAnalyzing) element("operation-status").textContent = ready ? "분석 완료" : "분석 실패";
  controls();
}

const poller = createAnalysisPoller({
  request,
  onState: render,
  shouldContinue: (state) => !["ready", "failed"].includes(state.status) || state.busy || busy,
  onConnectionError(error, delay) {
    connectionLost = true;
    element("connection-status").textContent = `${error.message} ${delay / 1000}초 후 상태 조회를 재시도합니다. PDF를 중복 제출하지 않습니다.`;
    controls();
  },
  onFatalError(error) {
    element("error").textContent = error.status === 404 ? "서버 재시작 등으로 이전 분석을 찾을 수 없습니다. PDF를 다시 올려 주세요." : error.message;
    element("operation-status").textContent = "상태 조회 중단";
    element("connection-status").textContent = "";
    analysisId = undefined;
    question = undefined;
    ready = false;
    analyzing = false;
    serverBusy = false;
    connectionLost = false;
    saveAnalysis(undefined);
    controls();
  },
});

element("reconnect").addEventListener("click", () => void poller.refresh());

async function perform(label, action) {
  busy = true;
  element("error").textContent = "";
  element("operation-status").textContent = label;
  controls();
  void poller.start(analysisId);
  try { await action(); element("operation-status").textContent = "완료"; }
  catch (error) { element("error").textContent = error.message; element("operation-status").textContent = "작업 실패"; }
  finally { busy = false; controls(); }
}

async function post(action, value) {
  return request(`/api/analyses/${analysisId}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
}

element("upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = element("pdf-file").files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { element("error").textContent = "PDF 파일은 최대 20 MiB까지 지원합니다."; return; }
  busy = true;
  analyzing = true;
  serverBusy = false;
  connectionLost = false;
  ready = false;
  question = undefined;
  analysisId = undefined;
  saveAnalysis(undefined);
  poller.stop();
  element("concept").replaceChildren();
  element("error").textContent = "";
  element("operation-status").textContent = "PDF 분석을 실행 중입니다.";
  for (const id of ["analysis-result", "question-result", "evaluation-result", "path-result", "events"]) showJson(id, null);
  controls();
  try {
    const mode = element("concept-mode").value || "detailed";
    const result = await request(`/api/analyses?filename=${encodeURIComponent(file.name)}&mode=${encodeURIComponent(mode)}`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: file });
    analysisId = result.id;
    saveAnalysis(analysisId);
    busy = false;
    await poller.start(analysisId);
  } catch (error) { element("error").textContent = error.message; analyzing = false; busy = false; controls(); }
});

element("concept").addEventListener("change", () => {
  question = undefined;
  showJson("question-result", null);
  showJson("evaluation-result", null);
  showJson("path-result", null);
  controls();
});

element("generate-question").addEventListener("click", () => perform("문제를 생성 중입니다.", async () => {
  question = undefined;
  controls();
  question = await post("questions", { conceptId: element("concept").value, type: element("question-type").value, difficulty: element("difficulty").value });
  showJson("question-result", question);
  showJson("evaluation-result", null);
  element("answer").value = "";
  element("answer-option").replaceChildren();
  const multipleChoice = question.question.type === "MULTIPLE_CHOICE";
  element("written-answer").hidden = multipleChoice;
  element("choice-answer").hidden = !multipleChoice;
  for (const value of question.question.options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    element("answer-option").append(option);
  }
}));

element("answer-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!question) return;
  void perform("답안을 평가 중입니다.", async () => {
    const answer = question.question.type === "MULTIPLE_CHOICE" ? element("answer-option").value : element("answer").value;
    showJson("evaluation-result", await post("evaluations", { questionId: question.questionId, answer }));
  });
});

element("recommend-path").addEventListener("click", () => perform("학습 경로를 추천 중입니다.", async () => {
  showJson("path-result", await post("path", { conceptId: element("concept").value }));
}));

request("/api/config").then((value) => {
  element("configuration").textContent = `AI 공급자: ${value.provider} / 모델: ${value.model || "미설정"} (.env 설정 사용)`;
}).catch((error) => { element("error").textContent = error.message; });
const previousAnalysis = savedAnalysis();
if (previousAnalysis) {
  analysisId = previousAnalysis;
  analyzing = true;
  element("operation-status").textContent = "이전 분석 상태를 확인 중입니다.";
  controls();
  void poller.start(analysisId);
}

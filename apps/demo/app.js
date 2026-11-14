import { createApiClient, createAnalysisPoller } from "./api.js";
import { createAiLoading } from "./loading.js";

const element = (id) => document.getElementById(id);
const showJson = (id, value) => { element(id).textContent = JSON.stringify(value, null, 2); };
let analysisId;
let question;
let questionSet;
let ready = false;
let busy = false;
let analyzing = false;
let serverBusy = false;
let connectionLost = false;
const request = createApiClient();
const withAiLoading = createAiLoading();
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
  element("question-picker").disabled = blocked || !questionSet;
  element("reconnect").disabled = !analysisId;
}

function showAnalysisProgress(value, label) {
  element("analysis-progress-container").hidden = false;
  const bar = element("analysis-progress");
  if (value === undefined) bar.removeAttribute("value");
  else bar.value = value;
  element("analysis-status").textContent = label;
}

function renderAnalysisProgress(state) {
  if (state.status === "ready") { showAnalysisProgress(100, "분석 완료 (100%)"); return; }
  if (state.status === "failed") {
    showAnalysisProgress(element("analysis-progress").value || 0, "분석 실패 — 진행이 중단되었습니다.");
    return;
  }
  const stages = [
    ["extracting_text", "text", "PDF 텍스트 추출 중"],
    ["extracting_concepts", "concepts", "개념 추출 중"],
    ...(state.mode === "conceptual" ? [["organizing_concepts", "organization", "핵심 개념 정리 중"]] : []),
    ["analyzing_relations", "relations", "관계 분석 중"],
    ["localizing", "localization", "언어 감지 및 한국어 번안 중"],
  ];
  const index = stages.findIndex(([status]) => status === state.status);
  if (index < 0) { showAnalysisProgress(undefined, "분석 대기 중"); return; }
  const [, stage, label] = stages[index];
  const prefix = `${index + 1}/${stages.length}단계 · ${label}`;
  const progress = state.events.filter((event) => event.kind === "progress" && event.stage === stage).at(-1);
  const cache = state.events.filter((event) => event.kind === "cache" && event.stage === stage).at(-1);
  if (cache?.status === "shared") {
    showAnalysisProgress(undefined, `${prefix} · 같은 자료의 분석 결과를 기다리는 중`);
  } else if (cache?.status === "hit") {
    showAnalysisProgress(100, `${prefix} · 저장된 결과 반영 중`);
  } else if (progress?.total > 0) {
    const percent = Math.min(100, Math.max(0, Math.round(progress.completed / progress.total * 100)));
    const round = /round (\d+)/.exec(progress.detail ?? "");
    showAnalysisProgress(percent, `${prefix}${round ? ` · ${round[1]}차 정리` : ""} · ${progress.completed}/${progress.total} ${stage === "localization" ? "문구" : "묶음"} (${percent}%)`);
  } else showAnalysisProgress(undefined, `${prefix} · 처리 중`);
}

function render(state) {
  const wasAnalyzing = analyzing;
  analyzing = !["ready", "failed"].includes(state.status);
  serverBusy = state.busy;
  connectionLost = false;
  element("connection-status").textContent = "";
  ready = state.status === "ready";
  renderAnalysisProgress(state);
  showJson("events", state.events);
  showJson("analysis-result", { mode: state.mode, material: state.material, graph: state.graph, detailedConcepts: state.detailedConcepts, localization: state.localization, error: state.error });
  if (state.status === "localizing") element("localization-status").textContent = "결과 출력 전에 언어를 확인하고 한국어로 번안하고 있습니다.";
  else if (wasAnalyzing) showLocalizationStatus(state.localization);
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
    showAnalysisProgress(element("analysis-progress").value || 0, "상태 조회 중단 — 분석 상태를 확인할 수 없습니다.");
    element("connection-status").textContent = "";
    analysisId = undefined;
    question = undefined; questionSet = undefined;
    ready = false;
    analyzing = false;
    serverBusy = false;
    connectionLost = false;
    saveAnalysis(undefined);
    controls();
  },
});

function showLocalizationStatus(report) {
  element("localization-status").textContent = report?.warning ?? (report?.status === "completed"
    ? `한국어 번안 완료: ${report.translated}/${report.detected}개 문구`
    : report?.status === "skipped" ? "언어 검사 완료: 추가 번안이 필요한 문구가 없습니다." : "");
}

element("reconnect").addEventListener("click", () => void poller.refresh());

async function perform(label, action) {
  if (busy) return;
  busy = true;
  element("error").textContent = "";
  element("localization-status").textContent = "";
  element("operation-status").textContent = label;
  controls();
  void poller.start(analysisId);
  try { await action(); element("operation-status").textContent = "완료"; }
  catch (error) { element("error").textContent = error.message; element("operation-status").textContent = "작업 실패"; }
  finally { busy = false; controls(); }
}

async function post(action, value) {
  return withAiLoading(action, () => request(`/api/analyses/${analysisId}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }));
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
  question = undefined; questionSet = undefined;
  analysisId = undefined;
  saveAnalysis(undefined);
  poller.stop();
  element("concept").replaceChildren();
  element("error").textContent = "";
  element("operation-status").textContent = "PDF 분석을 실행 중입니다.";
  element("localization-status").textContent = "";
  showAnalysisProgress(undefined, "PDF 업로드 중");
  for (const id of ["analysis-result", "question-result", "evaluation-result", "path-result", "events"]) showJson(id, null);
  controls();
  try {
    const mode = element("concept-mode").value || "detailed";
    const result = await request(`/api/analyses?filename=${encodeURIComponent(file.name)}&mode=${encodeURIComponent(mode)}`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: file });
    analysisId = result.id;
    saveAnalysis(analysisId);
    busy = false;
    await poller.start(analysisId);
  } catch (error) {
    element("error").textContent = error.message;
    showAnalysisProgress(0, "PDF 업로드 실패");
    analyzing = false;
    busy = false;
    controls();
  }
});

element("concept").addEventListener("change", () => {
  question = undefined; questionSet = undefined;
  element("question-picker").replaceChildren();
  showJson("question-result", null);
  showJson("evaluation-result", null);
  showJson("path-result", null);
  controls();
});

element("generate-question").addEventListener("click", () => perform("문제를 생성 중입니다.", async () => {
  question = undefined; questionSet = undefined;
  controls();
  question = await post("questions", { conceptId: element("concept").value, type: element("question-type").value, difficulty: element("difficulty").value });
  questionSet = question;
  element("question-picker").replaceChildren(...questionSet.questions.map((entry, index) => {
    const option = document.createElement("option"); option.value = index;
    option.textContent = `${index + 1} / ${questionSet.total} · ${entry.topic}`;
    return option;
  }));
  displayQuestion(0);
}));
function displayQuestion(index) {
  question = questionSet.questions[index];
  showLocalizationStatus(question.localization);
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
}
element("question-picker").addEventListener("change", () => {
  displayQuestion(Number(element("question-picker").value)); controls();
});

element("answer-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!question) return;
  void perform("답안을 평가 중입니다.", async () => {
    const answer = question.question.type === "MULTIPLE_CHOICE" ? element("answer-option").value : element("answer").value;
    const result = await post("evaluations", { questionId: question.questionId, answer });
    showJson("evaluation-result", result);
    showLocalizationStatus(result.localization);
  });
});

element("recommend-path").addEventListener("click", () => perform("학습 경로를 추천 중입니다.", async () => {
  const result = await post("path", { conceptId: element("concept").value });
  showJson("path-result", result);
  showLocalizationStatus(result.localization);
}));

request("/api/config").then((value) => {
  element("configuration").textContent = `AI 공급자: ${value.provider} / 모델: ${value.model || "미설정"} (.env 설정 사용)`;
}).catch((error) => { element("error").textContent = error.message; });
const previousAnalysis = savedAnalysis();
if (previousAnalysis) {
  analysisId = previousAnalysis;
  analyzing = true;
  element("operation-status").textContent = "이전 분석 상태를 확인 중입니다.";
  showAnalysisProgress(undefined, "이전 분석의 진행 상태를 확인 중입니다.");
  controls();
  void poller.start(analysisId);
}

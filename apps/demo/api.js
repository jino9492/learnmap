export class DemoApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function apiErrorMessage(error) {
  const reasons = { CONTEXT_LIMIT: "AI 입력이 모델의 처리 용량을 초과했습니다. 서버의 OLLAMA_CONTEXT_LENGTH를 늘리거나 자료와 답안의 분량을 줄여 주세요.", RATE_LIMIT: "AI 요청 또는 토큰 한도에 도달했습니다. 잠시 후 다시 시도하거나 공급자의 사용 한도를 확인해 주세요.", AUTH: "AI 인증 또는 접근 권한을 확인해 주세요. 서버의 API 키와 모델 접근 권한을 확인해야 합니다.", MODEL_NOT_FOUND: "설정한 AI 모델을 찾을 수 없습니다. 모델 이름과 설치 또는 제공 여부를 확인해 주세요.", UNAVAILABLE: "AI 모델 서버가 일시적으로 요청을 처리하지 못하고 있습니다. 잠시 후 다시 시도해 주세요." };
  if (error.code === "PROVIDER" && reasons[error.reason]) return reasons[error.reason];
  const messages = { CONFIG: "AI 연결 설정을 확인해 주세요. 서버의 .env에 공급자와 모델을 설정한 뒤 다시 시도할 수 있습니다.", TIMEOUT: "AI 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.", CONNECTION: "AI 모델 서버의 응답을 받지 못했습니다. 모델 실행 상태와 연결을 확인해 주세요.", FORMAT: "AI 응답이 필요한 형식을 충족하지 못해 분석을 중단했습니다. 다시 분석해 주세요.", SEMANTIC: "AI 분석 결과의 개념 또는 관계 검증에 실패했습니다. 다시 분석해 주세요.", PROVIDER: "AI 모델 서버에서 요청을 처리하지 못했습니다. 모델 상태와 요청 한도를 확인해 주세요.", REFUSAL: "AI 모델이 이 요청의 응답 생성을 거절했습니다.", INTERNAL: "요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.", INPUT: "자료 또는 입력 내용을 확인해 주세요. PDF는 텍스트를 포함해야 하며 파일은 20 MiB 이하여야 합니다.", DEMO_CONNECTION: "서버에 연결할 수 없습니다. 연결을 확인한 뒤 다시 시도해 주세요." };
  if (error.stage === "path" && ["SEMANTIC", "FORMAT"].includes(error.code)) return "추천 학습 경로의 개념 또는 선수 순서를 확인하지 못했습니다. 추천 학습 경로 생성을 다시 시도해 주세요.";
  const stage = { text: '본문 인식', concepts: '개념 추출', organization: '핵심 개념 정리', relations: '관계 분석', subject_relations: '파일 간 관계 분석', localization: '한국어 정리' }[error.stage];
  const detail = error.code === "OCR_REQUIRED" ? error.message : messages[error.code] ?? (/^[\x00-\x7F]*$/.test(error.message ?? "") ? "요청을 완료하지 못했습니다. 오류 기록을 확인해 주세요." : error.message);
  return stage ? `${stage} 단계: ${detail}` : detail;
}

export function createApiClient(fetcher = fetch) {
  return async (url, options) => {
    let response;
    try { response = await fetcher(url, options); }
    catch {
      throw new DemoApiError(0, "DEMO_CONNECTION", "데모 서버에 연결할 수 없습니다. npm run demo:web를 실행한 터미널이 계속 열려 있는지 확인하세요.");
    }
    let value;
    try { value = await response.json(); }
    catch { throw new DemoApiError(0, "DEMO_CONNECTION", "데모 서버의 응답을 끝까지 받지 못했습니다. 연결 상태를 다시 확인합니다."); }
    if (!response.ok) {
      const error = new DemoApiError(response.status, value.error?.code ?? "HTTP", value.error?.message ?? `HTTP ${response.status}`);
      error.stage = value.error?.stage ?? (/\/api\/analyses\/[^/]+\/path(?:\?|$)/.test(url) ? "path" : undefined);
      error.reason = value.error?.reason;
      throw error;
    }
    return value;
  };
}

export function createAnalysisPoller({ request, onState, onConnectionError, onFatalError, shouldContinue, schedule = setTimeout, cancel = clearTimeout }) {
  let id;
  let version = 0;
  let timer;
  let inFlight;
  let failures = 0;

  function stop() {
    cancel(timer);
    id = undefined;
    version++;
  }

  async function poll(currentVersion) {
    if (!id || currentVersion !== version || inFlight === currentVersion) return;
    cancel(timer);
    inFlight = currentVersion;
    try {
      const state = await request(`/api/analyses/${id}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (currentVersion !== version) return;
      failures = 0;
      onState(state);
      if (shouldContinue(state)) timer = schedule(() => void poll(currentVersion), 1500);
    } catch (error) {
      if (currentVersion !== version) return;
      if (error instanceof DemoApiError && error.status >= 400 && error.status < 500) {
        stop();
        onFatalError(error);
      } else {
        const delay = Math.min(10000, 1500 * 2 ** failures++);
        onConnectionError(error, delay);
        timer = schedule(() => void poll(currentVersion), delay);
      }
    } finally { if (inFlight === currentVersion) inFlight = undefined; }
  }

  return {
    start(analysisId) {
      stop();
      id = analysisId;
      failures = 0;
      return poll(version);
    },
    refresh() { return poll(version); },
    stop,
  };
}

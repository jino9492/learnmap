export class DemoApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
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
    if (!response.ok) throw new DemoApiError(response.status, value.error?.code ?? "HTTP", value.error?.message ?? `HTTP ${response.status}`);
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

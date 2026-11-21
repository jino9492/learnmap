const messages = {
  details: "원문을 바탕으로 세부 개념을 자세히 설명하고 있어요",
  questions: "학습 자료를 바탕으로 문제를 생성하고 있어요",
  evaluations: "답안의 개념 이해도를 분석하고 있어요",
  path: "맞춤 학습 경로를 만들고 있어요",
};

export function createAiLoading() {
  let dialog;
  let status;
  let description;
  let cancel;

  return async function withAiLoading(action, run, statusUrl) {
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "ai-loading";
      dialog.setAttribute("aria-labelledby", "ai-loading-title");
      dialog.setAttribute("aria-describedby", "ai-loading-description");
      dialog.addEventListener("cancel", (event) => event.preventDefault());
      const spinner = document.createElement("div");
      spinner.className = "ai-loading-spinner";
      spinner.setAttribute("aria-hidden", "true");
      status = document.createElement("h2");
      status.id = "ai-loading-title";
      status.tabIndex = -1;
      description = document.createElement("p");
      description.id = "ai-loading-description";
      description.textContent = "AI가 처리 중입니다. 잠시만 기다려 주세요.";
      cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "대기 취소";
      dialog.append(spinner, status, description, cancel);
      document.body.append(dialog);
    }
    status.textContent = messages[action] ?? "AI가 요청을 처리하고 있어요";
    description.textContent = "AI가 처리 중입니다. 잠시만 기다려 주세요.";
    const operation = new AbortController();
    cancel.hidden = true;
    cancel.onclick = () => operation.abort();
    let finished = false;
    let timer;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(statusUrl, { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const state = await response.json();
        if (!finished) {
          const waiting = state.queueState?.waiting > 0 && state.queueState.active === 0;
          cancel.hidden = !waiting;
          status.textContent = waiting ? "대기 중" : messages[action] ?? "AI가 요청을 처리하고 있어요";
          description.textContent = waiting
            ? "사용량 상한 또는 다른 AI 작업으로 대기 중입니다. 실행 가능해지면 자동으로 시작합니다."
            : "AI가 처리 중입니다. 잠시만 기다려 주세요.";
        }
      } catch { /* Keep the operation alive during a status polling failure. */ }
      finally { if (!finished) timer = setTimeout(poll, 1500); }
    };
    if (statusUrl) timer = setTimeout(poll, 500);
    dialog.showModal();
    status.focus();
    try { return await run(operation.signal); }
    catch (error) { if (operation.signal.aborted) throw new Error("AI 작업을 취소했습니다."); throw error; }
    finally { finished = true; clearTimeout(timer); controller.abort(); cancel.onclick = null; dialog.close(); }
  };
}

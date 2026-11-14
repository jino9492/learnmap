const messages = {
  questions: "학습 자료를 바탕으로 문제를 생성하고 있어요",
  evaluations: "답안의 개념 이해도를 분석하고 있어요",
  path: "맞춤 학습 경로를 만들고 있어요",
};

export function createAiLoading() {
  let dialog;
  let status;

  return async function withAiLoading(action, run) {
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
      const description = document.createElement("p");
      description.id = "ai-loading-description";
      description.textContent = "AI가 처리 중입니다. 잠시만 기다려 주세요.";
      dialog.append(spinner, status, description);
      document.body.append(dialog);
    }
    status.textContent = messages[action] ?? "AI가 요청을 처리하고 있어요";
    dialog.showModal();
    status.focus();
    try { return await run(); }
    finally { dialog.close(); }
  };
}

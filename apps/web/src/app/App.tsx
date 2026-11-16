import { AccountProvider } from "../features/accounts";
import { useRef, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { errorMessage } from "../utils/api";
import { OperationsContext } from "../hooks/useWorkspace";
import { Home } from "./Home";
import { SubjectLayout } from "./SubjectLayout";
import { FeedbackBanners, NotFound } from "../components/Shared";
import { GraphPage } from "../features/knowledge-graph";
import { ConceptPage } from "../features/concepts";
import { MaterialsPage } from "../features/materials";
import { QuizPage } from "../features/quiz";
import { PathPage } from "../features/learning-path";
import { HistoryPage } from "../features/learning-progress";

export const App = () => {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = async <T,>(
    text: string,
    action: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setMessage(text);
    try {
      const result = await action();
      setMessage((current) => (current === text ? "" : current));
      return result;
    } catch (error) {
      setMessage("");
      setError(errorMessage(error));
      return undefined;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <OperationsContext.Provider
      value={{
        busy,
        error,
        message,
        dismissError: () => setError(""),
        run,
        notify: setMessage,
      }}
    >
      <AccountProvider>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <FeedbackBanners />
                <Home />
              </>
            }
          />
          <Route path="/subjects/:subjectId" element={<SubjectLayout />}>
            <Route index element={<Navigate replace to="graph" />} />
            <Route path="graph" element={<GraphPage />} />
            <Route path="materials" element={<MaterialsPage />} />
            <Route path="concepts/:conceptId" element={<ConceptPage />} />
            <Route path="concepts/:conceptId/quiz" element={<QuizPage />} />
            <Route path="learning-path" element={<PathPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AccountProvider>
    </OperationsContext.Provider>
  );
};

import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ParallelDemo } from "./app/ParallelDemo";
import { App } from "./app/App";
import "../styles.css";
import "../../demo/loading.css";
import "./app/app.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 1000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <Routes>
        <Route path="/parallel" element={<ParallelDemo />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>,
);

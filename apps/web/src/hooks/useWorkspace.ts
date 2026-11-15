import { createContext, useContext } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subjectKey } from "../utils/api";
import type { Subject } from "../utils/api";

export interface Operations {
  busy: boolean;
  error: string;
  message: string;
  dismissError: () => void;
  run: <T>(message: string, action: () => Promise<T>) => Promise<T | undefined>;
  notify: (message: string) => void;
}
export const OperationsContext = createContext<Operations | null>(null);
export const useOperations = () => {
  const context = useContext(OperationsContext);
  if (!context) throw new Error("Missing operations provider.");
  return context;
};
export const useSubject = () => {
  const context = useContext(SubjectContext);
  if (!context) throw new Error("Missing subject provider.");
  return context;
};
export const SubjectContext = createContext<Subject | null>(null);
export const useRefreshSubject = () => {
  const client = useQueryClient();
  return async (id: string) => {
    await Promise.all([
      client.invalidateQueries({ queryKey: subjectKey(id) }),
      client.invalidateQueries({ queryKey: ["workspace"] }),
    ]);
  };
};

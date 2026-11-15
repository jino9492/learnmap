export function createAiLoading(): <T>(action: string, run: () => Promise<T>) => Promise<T>;

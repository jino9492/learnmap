export function createAiLoading(): <T>(action: string, run: (signal?: AbortSignal) => Promise<T>, statusUrl?: string) => Promise<T>;

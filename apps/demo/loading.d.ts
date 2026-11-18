export function createAiLoading(): <T>(action: string, run: () => Promise<T>, statusUrl?: string) => Promise<T>;

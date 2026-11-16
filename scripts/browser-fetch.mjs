// Node fetch has no browser cookie jar. Keep each simulated browser explicit.
export function createBrowserFetch(initialCookies = []) {
  const cookies = new Map(initialCookies);
  const browserFetch = async (url, options = {}) => {
    const headers = new Headers(options.headers);
    if (cookies.size && !headers.has('cookie')) headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await globalThis.fetch(url, { ...options, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      const key = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value) cookies.set(key, value);
      else cookies.delete(key);
    }
    return response;
  };
  return { fetch: browserFetch, cookies };
}

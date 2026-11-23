import { readFile } from "node:fs/promises";

const root = new URL("../../web/dist/", import.meta.url);
const contentTypes = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  woff2: "font/woff2",
};

// Serve only the compiled UI and its public assets, never arbitrary workspace files.
export async function webAsset(pathname, origin) {
  const isPage =
    pathname === "/" ||
    (!/^\/(api|demo)(\/|$)/.test(pathname) && !pathname.includes("."));
  const isAsset = /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|svg|png|woff2)$/.test(
    pathname,
  );
  if (!isPage && !isAsset && pathname !== "/web.js") return null;
  try {
    if (pathname === "/web.js") {
      const html = await readFile(new URL("index.html", root), "utf8");
      const entry = /src="(\/assets\/[^" ]+\.js)"/.exec(html)?.[1];
      return entry
        ? { content: `import ${JSON.stringify(entry)};`, type: contentTypes.js }
        : null;
    }
    if (isPage) {
      const html = await readFile(new URL("index.html", root), "utf8");
      return {
        content: html.replace('content="/assets/learnmap-share.png"', `content="${origin}/assets/learnmap-share.png"`),
        type: "text/html; charset=utf-8",
      };
    }
    return {
      content: await readFile(new URL(pathname.slice(1), root)),
      type: contentTypes[pathname.split(".").at(-1)],
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

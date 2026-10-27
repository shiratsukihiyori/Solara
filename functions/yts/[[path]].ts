// 同源转发：/s/* /youtubei/* /yts/* /embed/* -> www.youtube.com
// 目的：让无法直连 YouTube 的用户通过本站加载官方播放器
// 要点：转发 Cookie（含验证后产生的会话），改写 Set-Cookie 到本站域名；JS 内容原样返回

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function rewriteText(body: string): string {
  return body
    .replace(/https:\/\/([a-z0-9-]+\.googlevideo\.com)/gi, "/ytp/h/$1")
    .replace(/https:\/\/(i\.ytimg\.com|yt3\.ggpht\.com|yt3\.googleusercontent\.com|www\.gstatic\.com)/gi, "/ytp/h/$1")
    .replace(/(src|href|action)="https:\/\/(www\.)?youtube\.com([^"]*)"/gi, '$1="$3"')
    .replace(/(src|href|action)="\/\/(www\.)?youtube\.com([^"]*)"/gi, '$1="$3"');
}

function relaySetCookie(upstream: Response, out: Headers): void {
  const anyHeaders = upstream.headers as any;
  const list: string[] = typeof anyHeaders.getSetCookie === "function" ? anyHeaders.getSetCookie() : [];
  for (const cookie of list) {
    const cleaned = cookie
      .replace(/;\s*Domain=[^;]+/gi, "")
      .replace(/;\s*Secure/gi, "")
      .replace(/;\s*Partitioned/gi, "")
      .replace(/;\s*SameSite=None/gi, "; SameSite=Lax");
    out.append("set-cookie", cleaned);
  }
}

const handle: PagesFunction = async ({ request }) => {
  const url = new URL(request.url);
  const target = `https://www.youtube.com${url.pathname.replace(/^(?:\/ytp\/h\/www\.youtube\.com)/, "")}${url.search}`;

  const origin = new URL(request.url).origin;
  const headers = new Headers(request.headers);
  for (const key of [
    "host", "connection", "content-length", "accept-encoding", "origin", "referer",
    "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cdn-loop",
    "x-forwarded-for", "x-real-ip", "x-forwarded-proto", "x-forwarded-host",
  ]) {
    headers.delete(key);
  }
  headers.set("user-agent", UA);
  headers.set("referer", origin + "/");
  headers.set("origin", "https://www.youtube.com");

  let body: BodyInit | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
  }

  const upstream = await fetch(target, {
    method: request.method === "HEAD" ? "GET" : request.method,
    headers,
    body,
    redirect: "follow",
  });

  const out = new Headers(CORS);
  out.set("content-type", upstream.headers.get("content-type") || "application/octet-stream");
  for (const key of ["content-range", "accept-ranges", "etag", "last-modified", "content-length"]) {
    const v = upstream.headers.get(key);
    if (v) out.set(key, v);
  }
  out.set("cache-control", "no-store");
  relaySetCookie(upstream, out);

  const ctype = out.get("content-type") || "";
  if (/javascript/i.test(ctype)) {
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
  if (/json|html|text\/plain|css/i.test(ctype)) {
    const text = await upstream.text();
    out.delete("content-length");
    return new Response(rewriteText(text), { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
};

export const onRequestGet = handle;
export const onRequestPost = handle;
export const onRequestHead = handle;
export const onRequestOptions: PagesFunction = async () => new Response(null, { status: 204, headers: CORS });

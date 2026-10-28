// /api/wallpaper —— 动态壁纸代理
// loliapi 现在对非浏览器请求返回 JS 挑战页，background-image 拿不到图；
// 这里由 Worker 跟随重定向并把真正的图片字节回给前端。

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SOURCES = [
  "https://www.loliapi.com/acg",
  "https://www.loliapi.com/acg/pc/",
  "https://www.loliapi.com/acg/pe/",
];

function imageResponse(res: Response): Response {
  const headers = new Headers();
  headers.set("content-type", res.headers.get("content-type") || "image/webp");
  const len = res.headers.get("content-length");
  if (len) headers.set("content-length", len);
  headers.set("access-control-allow-origin", "*");
  headers.set("cache-control", "no-store");
  return new Response(res.body, { status: 200, headers });
}

export const onRequestGet: PagesFunction = async ({ request }) => {
  const url = new URL(request.url);
  const seed = url.searchParams.get("_") || String(Date.now());
  const errors: string[] = [];

  for (const base of SOURCES) {
    const target = `${base}${base.includes("?") ? "&" : "?"}_=${encodeURIComponent(seed)}`;
    try {
      const res = await fetch(target, {
        headers: {
          "user-agent": UA,
          accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          referer: "https://www.loliapi.com/",
        },
        redirect: "follow",
      });
      const type = res.headers.get("content-type") || "";
      if (res.ok && type.startsWith("image/")) {
        return imageResponse(res);
      }
      errors.push(`${base}: ${res.status} ${type}`);
    } catch (error: any) {
      errors.push(`${base}: ${String(error?.message || error).slice(0, 60)}`);
    }
  }

  return new Response(JSON.stringify({ error: "wallpaper unavailable", details: errors }), {
    status: 502,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
};

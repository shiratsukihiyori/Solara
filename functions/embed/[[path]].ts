// /embed/<videoId> —— 与官方同路径的 embed 代理页
// 播放器会从 pathname 解析视频 id，路径必须保持 /embed/xxx
import { handleEmbedProxy } from "../ytp/[[path]]";

export const onRequestGet: PagesFunction = async ({ request, params }) => {
  const videoId = String((params as any).path?.[0] || "");
  return handleEmbedProxy(videoId, request);
};

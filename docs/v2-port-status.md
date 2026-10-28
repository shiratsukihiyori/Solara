# Solara v2 迁移状态（白月日和 Remix）

> 分支：`v2-port`（基于上游 v2.1.6）　预览：https://v2.solara-6nj.pages.dev
> 生产：`main`（旧版，未切换）　最后更新：2026-10-28

## 一、为什么分开

上游 2.0 是把单体脚本拆成模块的重写（66 文件、+18.6k/−10.8k）。我们的 YouTube 音源、代理播放器、MP3 下载全写在旧单体里，直接 merge 会得到坏掉的混合体。

做法：**以 v2.1.6 为底座，把我们的东西移植过去**，在 preview 验证后再切生产。

## 二、已完成

### 后端（两版通用，已上线生产）
- `functions/api/music.ts`：`type=search|url|stream|lyric|pic|img`，source = `kuwo | youtube`
  - 酷我：搜索 / 直链 / 歌词（5 次重试）/ 封面
  - YouTube：Innertube 搜索（WEB_REMIX）、取票（VISIONOS + visitorData）、流代理（Range 透传）
  - **取票失败自动回退 VPS 中继**（`YT_RELAY_BASE`，见下）
- 反向代理路由：`/embed/<id>` `/s/*` `/youtubei/*` `/yts/*` `/ytp/*`（YouTube 官方播放器整页代理）
- nubia 网关放行数据路径：`/api/ /proxy/ /embed/ /s/ /youtubei/ /yts/ /ytp/`
  （否则 `<img>`/`<audio>`/iframe 拿到的是验证页 → 裂图 / 拒绝连接）

### VPS 中继（14.137.255.43）
- `ytproxy.service`：mihomo + 他的订阅，本地 7899，每天 04:17 自动刷新
- `ytaudio.service`：`:8931`，yt-dlp 取票（代理失败自动直连），媒体直连拉流 + Range
- cloudflared 临时隧道 → 目前写进 Pages secret `YT_RELAY_BASE`
  ⚠️ 临时隧道地址会变；长期要稳定需加 DNS（`yt` → VPS，灰云）或命名隧道

### 前端（v2 分支）
- **品牌换皮**：`css/tokens/theme.css` 整套换成夜空/月光/日和绿；浅色=日和暖米
- **首屏不再闪上游 UI**：布局 CSS 改 media 查询阻塞加载（原来 JS 注入后再套层），
  首屏只画白月日和月亮 loader，样式就绪后淡出
- YouTube 音源：搜索 / 播放（`<audio>` 直接吃 `/api/music?type=stream`，可拖动、可暂停）/
  封面（视频缩略图，走同源图片代理）/ 歌词显示「不支持歌词」/ 下载（m4a）
- 标题与徽标换品牌（SOLARA / 白月日和），去掉上游署名

## 三、实测记录（预览环境，headless Edge）

| 项 | 结果 |
|---|---|
| YouTube 搜索「鹿乃 ういこうせん」 | 13 条，源标签 YouTube Music |
| 播放 | `readyState=4`，`duration≈266s`，10 秒后 `currentTime=10.9` |
| 拖动 | 跳到 60s，6 秒后 65.9s，未暂停 |
| 封面 | `naturalWidth=120→480`（hqdefault 经图片代理） |
| 歌词 | 显示「不支持歌词」 |
| 移动端 390×844 | `mobile-view`，`scrollWidth == innerWidth`（无横向溢出） |
| 生产回归 | 首页 200 / 搜索 200 / 流 206 `audio/mp4` |

## 四、还没搬的

1. **设置面板**：旧版自定义项（网易云歌单输入、雷达风格全选/清空、心动模式文案）未移植；v2 自带设置面板结构不同
2. **MP3 转码下载**：v2 目前 YouTube 下载是 m4a；旧版的 lamejs 128/192/320k 转码未搬
3. **搜索分页**：YouTube Music 接口无 continuation（实测 0 个续页 token），加载更多对 YouTube 保持隐藏
4. **自定义歌单兜底 / 雷达逻辑**：旧版改动未逐项比对

## 五、怎么切生产（等确认）

```bash
# 1. 预览确认无误后，把 v2-port 合到 main
git switch main
git merge v2-port
node --check js/index.js      # 旧版单体仍在，确保没冲突残留
git push

# 2. 或者直接部署当前工作树（不走 git）
HTTPS_PROXY=... node .../wrangler.js pages deploy . --project-name solara --branch main
```

回滚：`main` 上一次提交 `c6b7e68`（旧版 + 启动屏 + 中继兜底）。

## 六、已知风险

- 临时隧道失效 → YouTube 流回退失败（表现为 `youtube_bot_check` / 音频加载失败）
- 订阅节点在境内不可用（已实测 0/74），只影响"服务器走代理"这条；yt-dlp 直连兜底仍可用
- v2 是 ESM 模块结构，任何 `node --check` 只能检查单文件语法，改动需浏览器实测

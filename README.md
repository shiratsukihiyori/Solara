# Solara Hiyori Remix

> 基于 [Akudamatata/Solara](https://github.com/akudamatata/Solara) 修改的个性化音乐播放器，部署于 Cloudflare Pages。

## 特性

- **跨源搜索** — 一键切换网易云/酷我等数据源，分页浏览并批量导入
- **双通道 API** — 优先 JSONP 直连上游，失败自动降级到 Pages Function 代理转发，破除 WAF 封锁
- **Dynamic Gradient** — 天空风格渐变背景跟随调色板动态变化，与壁纸互斥切换
- **双重取色算法** — 后端 Palette Function 分析封面色调，失败时自动降级到前端 Canvas
- **暗色模式** — 跟随系统或手动切换，无缝过渡
- **竖屏移动端** — 专为手机优化的布局与手势
- **动态歌词** — 逐行滚动高亮，手动滚动后 3 秒自动回位
- **收藏系统** — 独立播放进度与批量操作
- **多码率播放与下载** — 128K / 192K / 320K / FLAC
- **锁屏控制** — MediaSession API 支持
- **播放列表导入/导出** — JSON 格式一键迁移
- **调试面板** — 按 Ctrl+D 呼出实时日志

## API 架构

```
┌──────────┐     ┌──────────────────────────┐
│ Browser  │────▶│ music-api-hk.gdstudio.xyz│  ← JSONP 直连（优先，无跨域限制）
│ (script) │     └──────────────────────────┘
│          │
│          │     ┌──────────┐  ┌──────────┐
│ (fetch)  │────▶│ /proxy   │─▶│ upstream │  ← 降级到代理转发
└──────────┘     └──────────┘  └──────────┘
```

- **JSONP 直连**：`<script>` 标签绕过跨域限制，请求从用户 IP 发出，上游 WAF 放行
- **代理转发**：JSONP 超时/失败后自动降级到 `functions/proxy.ts`，聊作后备

## 部署（Cloudflare Pages）

### 前置准备

1. Fork 本仓库到你的 GitHub
2. 开通 [Cloudflare Pages](https://pages.cloudflare.com/)

### 步骤

1. 在 Cloudflare Dashboard 进入 **Workers & Pages → Create application → Pages → Connect to Git**
2. 授权并选择你的 Solara 仓库
3. 构建设置：
   - **Framework preset**: None
   - **Build command**: 留空
   - **Build output directory**: `.`
4. 点击 **Save and Deploy**

### 环境变量（可选）

在 Pages 项目 **Settings → Environment variables** 中添加：

| 变量 | 说明 |
|------|------|
| `PASSWORD` | 开启访问口令保护 |
| `LANGUAGE=ENG` | 切换为英文界面 |

### D1 数据库（可选）

1. 创建 D1 数据库 `solara-db`
2. 在 Pages 项目设置中绑定 Binding name `DB` 到该数据库
3. 执行建表语句：

```sql
CREATE TABLE IF NOT EXISTS playback_store (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS favorites_store (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

## 本地开发

```bash
npm install
npm run dev
npm run deploy
```

## 项目结构

```
├── css/
│   ├── desktop.css       # 桌面端布局
│   ├── mobile.css        # 移动端适配
│   └── style.css         # 主题与公共变量
├── functions/
│   ├── _middleware.ts    # 中间件（认证/国际化）
│   ├── proxy.ts          # API 代理与缓存（降级通道）
│   ├── palette.ts        # 封面取色
│   └── api/
│       ├── login.ts      # 登录认证
│       └── storage.ts    # D1 存储
├── js/
│   ├── index.js          # 核心逻辑（含双通道 API / 渐变背景）
│   └── mobile.js         # 移动端交互
├── index.html
├── login.html
├── package.json
├── wrangler.toml
└── .gitignore
```

## 使用

1. 输入关键词并选择曲库发起搜索
2. 点击结果可播放、下载或加入队列
3. 心形图标收藏歌曲
4. 底部控制栏提供播放控制、进度条与音量
5. 打开歌词面板查看实时滚动歌词

## 致谢

- [Akudamatata](https://github.com/akudamatata) — [Solara 原版](https://github.com/akudamatata/Solara)
- [GD音乐台](https://music.gdstudio.xyz) — 免费音乐 API
- [牛就是牛@ufoo](https://linux.do/t/topic/942415) — 灵感启发

## 许可证

[CC BY-NC-SA 4.0](LICENSE) — 禁止商用，衍生项目必须保留出处并以相同协议开源。

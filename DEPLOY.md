# 部署说明

一切都是**静态文件**：`npm run build` 之后把 `docs/` 整个目录扔到任何能提供静态文件的服务器上即可。
没有后端、没有数据库、没有环境变量。

> ⚠️ 唯一的硬性要求：**必须通过 HTTPS（或 `localhost`）访问**。
> Service Worker 在非安全上下文里根本不注册，离线能力会整体失效。
> 本地用 `npm run preview` 是 `localhost`，属于安全上下文，没问题。

---

## 1. 构建

```bash
npm ci
npm run build
```

`npm run build` 做三件事：

1. `tsc --noEmit` —— 类型不过就不出包；
2. `vite build` —— 产物在 `docs/`；
3. `node tools/postbuild.mjs`：
   - 生成构建号 `YYYYMMDD-HHmm-xxxx`，写进 `sw.js` 与 `version.json`；
   - 枚举 `docs/` 实际产物，注入 `sw.js` 的预缓存列表（不猜路径——带哈希的文件名每次都变）；
   - 按 mtime 保留最近 3 代 `assets/`，删掉更早的；
   - 打印体积表，**首屏代码 gzip 超过 400 kB 直接失败**（CI 能拦住）。

产物体积参考（v0.1.0）：

| 文件 | 原始 | gzip |
| --- | --- | --- |
| `assets/phaser-*.js` | 1447 kB | 329 kB |
| `assets/index-*.js` | 71 kB | 27 kB |
| `assets/style-*.css` | 10 kB | 3 kB |
| 其余（index.html / manifest / sw / 图标） | ~38 kB | ~30 kB |
| **首屏代码合计** | — | **≈ 363 kB / 预算 400 kB** |

体积几乎全是 Phaser 本身。想再压：把 `manualChunks` 里的 phaser 换成按需 import（不划算，
核心就是引擎）；或者接受首屏大、靠 SW 第二次起零加载。

---

## 2. 直接丢到静态主机

以 Nginx 为例：

```nginx
server {
  listen 443 ssl;
  server_name game.example.com;
  root /var/www/eartheno;      # 把 docs/ 的内容放这里

  # 带哈希的产物可以永久缓存
  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  # index.html 与 sw.js 绝不能长缓存 —— 否则更新永远推不下去
  location = /index.html     { add_header Cache-Control "no-cache"; }
  location = /sw.js          { add_header Cache-Control "no-cache"; }
  location = /version.json   { add_header Cache-Control "no-cache"; }

  # 图标可长缓存
  location /icons/ {
    add_header Cache-Control "public, max-age=604800";
  }

  try_files $uri $uri/ /index.html;
}
```

**缓存头是 PWA 最容易翻车的地方**：`index.html` / `sw.js` 被 CDN 或浏览器缓存住，
用户就永远停在旧版本，还会以为是你没更新。

---

## 3. 部署到子目录

`vite.config.ts` 里 `base: './'`，所有资源都是相对路径，因此：

- ✅ `https://example.com/eartheno/`
- ✅ `https://example.com/some/deep/path/`
- ✅ `https://user.github.io/repo-name/`

都不需要改一行配置，直接把 `docs/` 放到对应目录即可。

> 注意 `manifest.webmanifest` 的 `start_url` 与 `scope` 也用了 `./`。
> 如果你希望安装后的图标**直接打开某个子路径**，把 `start_url` 改成 `"./"` 之外的显式值时要保证
> 它落在 `scope` 内，否则 Chrome 会拒绝安装。

### GitHub Pages（重点）

GitHub Pages 的 **「Deploy from a branch」只允许选仓库根目录 `/` 或 `/docs`**，
选不了 `/dist` 之类的任意子目录。本项目因此把产物直接输出到 `docs/`，
源码和可部署文件可以待在同一个仓库里。

> 只有两个目录名是合法的：`/`（仓库根）与 `/docs`。想用别的目录名（比如 `/public`、
> `/build`），必须改用 GitHub Actions 上传 artifact —— 见下面的「方式 B」。

#### 方式 A：分支 + /docs（零配置，推荐个人项目）

```bash
npm run build                        # 产物写到 docs/
GHP_BASE=/eartheno/ npm run build    # 项目页请用绝对 base，eartheno 换成你的仓库名
git add docs && git commit -m "build" && git push
```

然后在仓库 **Settings → Pages → Build and deployment**：

| 项 | 值 |
| --- | --- |
| Source | Deploy from a branch |
| Branch | `main` |
| Folder | **`/docs`** |

站点地址是 `https://<用户名>.github.io/<仓库名>/`。

**为什么建议用 `GHP_BASE=/<仓库名>/` 而不是默认的 `./`：**
相对路径 `./` 在绝大多数场景都能跑（实测过子目录、无尾斜杠、显式 index.html、离线重开），
但它对**深层 URL** 不健壮 —— 页面一旦出现在 `/repo/a/b/`，`./assets/x.js` 会解析到
`/repo/a/b/assets/x.js` 而 404。GitHub Pages 不做 SPA 回退、本项目也不产生深层 URL，
所以默认的 `./` 目前是安全的；用绝对 base 只是把"以后别踩"这个隐患提前消掉。

#### 方式 B：GitHub Actions（产物不进 git）

仓库里已经带好 `.github/workflows/pages.yml`，推送到 `main` 即自动构建 + 发布，
产物不经过 git，仓库更干净，也不会出现"忘了 build 就提交"。

设置处只需把 **Source** 选成 **GitHub Actions**，其余交给工作流。工作流里已经：

- 用 `GHP_BASE=/${{ github.event.repository.name }}/` 构建（自动取仓库名，不用手改）；
- 上传 `docs/` 作为 Pages artifact；
- 并发控制 `cancel-in-progress`，连续 push 不会互相覆盖。

另一种常见做法是把产物推到 `gh-pages` 分支，再从该分支根目录发布：

```bash
npm run build && npx gh-pages -d docs --dotfiles
```

> `--dotfiles` 不能省：产物里的 `.nojekyll` 是隐藏文件，默认不会被 `gh-pages` 推送上去，
> 缺了它 Jekyll 会介入处理，`_` 开头的文件/目录可能被吞掉。

#### 三种方式的取舍

| | 方式 A（/docs） | 方式 B（Actions） | gh-pages 分支 |
| --- | --- | --- | --- |
| 需要 CI | 否 | 是（仓库自带） | 否 |
| 产物进主分支 | 是 | 否 | 否 |
| 忘记 build 的风险 | 有 | 无 | 有 |
| 配置复杂度 | 最低 | 低 | 中 |

另外 `.github/workflows/test.yml` 会在每次 push / PR 上跑类型检查、128 个单测、
构建（含体积预算）与 29 个端到端用例，CI 上失败的重试 2 次以吸收 runner 冷启动抖动。

#### GitHub Pages 的两个额外注意点

- **必须 HTTPS**（Pages 默认提供）。Service Worker 与"添加到桌面"都要求安全上下文。
- **缓存头不可控**：Pages 给静态资源发 `cache-control: max-age=600`，`sw.js` 也在其中。
  这意味着旧 SW 最长可能存活 10 分钟才会被浏览器重新拉取。
  本项目已用 `updateViaCache: 'none'` 规避（注册 SW 时强制绕过 HTTP 缓存），
  所以更新提示一般在用户下次打开时就会出现，不会卡 10 分钟。

### Vercel / Netlify / Cloudflare Pages

零配置，直接选这个仓库即可：

| 项 | 值 |
| --- | --- |
| Build command | `npm run build` |
| Output directory | `docs` |
| Node version | ≥ 20 |

---

## 4. 为什么 `build.emptyOutDir = false`

文件名带内容哈希。如果每次构建都清空输出目录：

1. 用户 A 还开着旧页面，旧页面引用的 `index-AAA.js` 已经被删；
2. 新 SW 接管，旧页面恰好要懒加载某个旧 chunk；
3. 请求 404 → 白屏，且用户不知道该刷新。

所以保留**最近 3 代** `assets/`，让"正在玩旧版本的会话"能安全着陆。
`tools/postbuild.mjs` 里按 mtime 聚类删除更早的代，清理动作放在「枚举预缓存」与「体积统计」**之前**
（否则旧文件会被写进新的 precache 列表，还会让首屏体积虚高）。

---

## 5. 更新机制

1. 页面启动时请求 `version.json`（永远走网络），与当前构建号比对；
2. 不一致 → 等新 SW `installed` → 顶部横幅「有新版本」；
3. 用户点确认 → `postMessage('skip-waiting')` → reload。

**首次接管不提示**，否则第一次打开就弹一个毫无意义的框。
SW 也**不会**自动 `skipWaiting` —— 打到一半被强制刷新是最糟的体验。

---

## 6. 添加到桌面

- **Android Chrome**：地址栏右侧会出现"安装"图标，或菜单 →「安装应用」/「添加到主屏幕」。
  装好后全屏、锁定横屏（`display_override: ["fullscreen"]` + `orientation: landscape`）。
- **iOS Safari**：只能手动 —— 分享按钮 →「添加到主屏幕」。iOS 不支持 `requestFullscreen`，
  也忽略 manifest 里的 `display` 部分字段；本项目通过 `viewport-fit=cover` + 安全区内边距
  处理刘海，并在全屏按钮不存在时自动隐藏该按钮。
- 竖屏打开时会显示「请把手机横过来」的闸门，转回横屏自动消失。

---

## 7. 离线验证清单

部署后按顺序验一遍（E2E 里也是这么测的）：

1. 打开页面 → DevTools → Application → Service Workers，看到 `sw.js` 已 `activated`；
2. Cache Storage 里出现 `eartheno-<构建号>`，条目包含 `index.html`、`assets/*.js`、`*.css`、`manifest.webmanifest`；
3. DevTools 切 Offline → 刷新 → 仍能进游戏、能挖能放；
4. 再发一版（改构建号）→ 刷新 → 顶部出现「有新版本」；
5. `version.json` 内容与 `sw.js` 里的 `BUILD` 一致。

---

## 8. 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 改了代码，线上没变 | `index.html` / `sw.js` 被缓存 | 检查缓存头；DevTools 勾 "Update on reload" |
| 更新后白屏 | `emptyOutDir: true` 把旧 chunk 删了 | 改回 `false`，用 postbuild 的 3 代保留 |
| 离线打不开 | SW 没注册（HTTP / 子路径 scope 不对） | 必须 HTTPS；确认 `sw.js` 在站点根或对应子目录 |
| 安装提示不出现 | 缺 192/512 图标或缺 manifest | 检查 `manifest.webmanifest` 能否 200 访问 |
| 子目录部署资源 404 | 用了绝对路径 `/assets/...` | 保持 `base: './'`，别手写绝对路径 |

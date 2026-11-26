# 华为 Mate 70 Pro+ HTTPS 手机部署与真机核对指南

浏览器安全策略规定：**GPS 高精度定位、电子罗盘方向传感器、外接麦克风/声卡音频流**在手机浏览器上**必须通过 `https://` 打开**（本地 `http://192.168.x.x` 会被浏览器直接拒绝权限）。

下面给出 2 种最省事的 HTTPS 部署方式，以及华为 Mate 70 Pro+ 实测核对清单。

---

## 方式一：GitHub Pages 自动 HTTPS 部署（已配置！）

本项目已配置 `.github/workflows/deploy.yml`：每次推送到 `main` 分支后，GitHub Actions 会自动跑单元测试、打包并发布到永久 HTTPS 网址：

- **线上访问地址**：`https://yijun-yu.github.io/ardf-navigator/`

如果某次国内校园网访问 `github.io` 偶尔较慢，也可以按下面任意方式多配一个国内/全球 CDN 镜像：

### 备选 A：Cloudflare Pages（拖拽文件夹，1 分钟上线）
1. 在电脑项目目录下打包最新产物：
   ```powershell
   cd D:\Antigravity\ardf-navigator
   npm run build
   ```
   打包完成后会生成 `D:\Antigravity\ardf-navigator\dist` 文件夹。
2. 打开 [dash.cloudflare.com](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → **Upload assets（直接上传）**。
3. 把整个 `dist` 文件夹拖进去部署，几秒后会得到一个永久免费的 `https://xxx.pages.dev` 网址。

### 方案 B：Vercel（同样免费支持静态目录/GitHub 自动发布）
```powershell
npx vercel --prod
```
按提示回车即可自动获得 `https://xxx.vercel.app` 网址。

---

## 方式二：本机开发版 30 秒临时 HTTPS 透传（边改代码边手机测）

如果还在调代码不想反复打包上传，可以用免费的 Cloudflare Quick Tunnel：
1. 终端 1 启动本地开发服务器：
   ```powershell
   cd D:\Antigravity\ardf-navigator
   npm run dev
   ```
2. 终端 2 启动临时 HTTPS 隧道（无需注册账号）：
   ```powershell
   cloudflared tunnel --url http://localhost:5173
   ```
3. 复制终端输出的 `https://xxxx.trycloudflare.com`，用华为手机浏览器直接打开即可实时联调。

---

## 华为 Mate 70 Pro+（鸿蒙系统）真机实测核对清单

### 1. 添加为独立全屏 App（PWA）
- 用**华为浏览器**打开部署好的 `https://` 网址；
- 点右下角菜单 → **「添加到桌面」**（已配置独立图标与离线缓存），之后像原生 App 一样全屏启动，无地址栏遮挡。

### 2. 配置高德地图（约 2 分钟）
- 前往 [lbs.amap.com](https://lbs.amap.com/) 免费注册个人开发者 → 创建应用 → 添加 **Web 端（JS API）** Key，同时复制对应的 **安全密钥（jscode）**；
- 在本应用右上角点 **⚙ 设置**，填入 Key 与安全密钥并保存（仅保存在本机浏览器 `localStorage`，不上传任何服务器）。

### 3. 传感器与音频权限核对
- **GPS 定位**：首次打开点击允许位置权限；首次室外冷启动约需 3–10 秒收敛到 `±5m` 以内；
- **电子罗盘**：如果发现箭头指向偏斜，手持手机在空中画 2–3 个 **“∞” 8 字**完成地磁校准；也可在 **⚙ 设置** 中微调罗盘固定偏角；
- **防磁棒干扰动作**：使用 80m 测向机时，**左手测向机、右手手机保持 25–30 cm 间距**固定在胸前，用身体转动带动两手一起转半圈；
- **外接 Type-C 声卡 / 音频线**：
  1. 在华为手机「设置」中确认 **OTG 连接** 处于开启状态；
  2. 接线顺序：`测向机 3.5mm 耳机孔 → 一分二音频分线器 → 一路接你的有线耳机，另一路经衰减对录线接 Type-C 数字声卡独立麦克风孔 → 手机 Type-C 口`；
  3. 测向机音量调到中等不破音（顶部音频条出现红色「爆音」标签时请稍微调小音量）。

### 4. 无硬件快速校园演练（今天就能下楼测！）
不需要等买测向机或发射台：
1. 手机打开应用，顶部选好校区（紫金港 / 玉泉 / 华家池），点右上角 **「🏃演练」**（默认「近距」会在你周围 80–350m 藏 6 个目标台 + 3 个干扰台）；
2. 戴上耳机滑动虚拟 3.50–3.60 MHz 旋钮，听清电码自动识别（拧到干扰台立刻触发全屏红闪报警）；
3. 点 **「🔄 转半圈测向」** 并拿着手机原地慢转半圈（180°），自动算出方向落线；走 50–100m 再转半圈出红点；
4. 跟随高德地图高亮青色路线 `① → ② → ③…` 跑到隐藏点 25m 内点击 **「✓ 模拟打卡」**，跑完点 **「👁真位」** 复盘对比误差！

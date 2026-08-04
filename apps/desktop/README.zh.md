# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文


DeepSeek Harness Web GUI 的 Electron 外壳：它启动 `dsh web`，等待服务器的就绪行，然后在独立窗口中承载 GUI。关闭窗口会隐藏它并让服务器在托盘继续运行；托盘菜单可重新打开窗口或退出应用（连同服务器一起退出）。每台机器只允许一个实例——第二次启动会聚焦已有窗口，而不是再起一个服务器。

## 从检出目录运行

先构建仓库——`pnpm run build` 产出 CLI lib、web dist 与本包的 lib——然后：

```sh
pnpm --filter @deepseek-ai/dsh-desktop dev
```

启动器按以下顺序解析 `dsh web`：

1. `DSH_BIN` —— 显式指定的可执行文件路径（适合自定义 CLI 构建）；
2. 嵌入闭包 `deploy/node_modules/@deepseek-ai/dsh/lib/bin.js`（只要 `deploy/` 已物化——打包版必然有，dev 检出目录在 `deploy:closure` 之后也会有；见「打包」）；
3. 本检出目录的 CLI —— 有构建产物 `apps/cli/lib/bin.js` 时用它，否则用根 `pnpm run dsh` 脚本所用的 tsx 源码启动（`node --import tsx/esm apps/cli/src/bin.ts`）；
4. `PATH` 上的 `dsh`。

服务器始终监听 `127.0.0.1` 的 OS 分配端口（`--port 0`），因此永远不会与现有 `dsh web` 冲突；从 stdout 解析就绪行 `dsh web: http://127.0.0.1:<port>`，然后轮询 HTTP 200。回环请求默认通过 /api 浏览器信任栅栏，因此无需额外标志。

## 行为说明

- 窗口是普通沙箱化渲染进程（`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`），没有 preload：GUI 就是普通 Web 应用。会打开新窗口或离开服务器源站点的链接一律交给系统浏览器。
- 关闭窗口不会退出——服务器继续运行，托盘图标保留。**退出**会终止 `dsh web` 进程树并退出应用。在 Windows 上树杀用 `taskkill /T`（`child.kill()` 只是直接子进程的 `TerminateProcess`），服务器不会走优雅 dispose 路径；会话数据按事件写入 JSONL，因此被杀的服务器不会丢失已记录的内容。
- Windows 没有 harness 隔离后端，CLI 默认的 `workspace-write` 权限模式在那里无法启动。未设置 `DSH_PERMISSION_MODE` 时外壳兜底为 `danger-full-access`（审批提示被禁用）并打印警告；显式设置 `DSH_PERMISSION_MODE` 可覆盖。
- 如果 Electron 主进程被硬杀（任务管理器、崩溃），一个小的 reaper 子进程会轮询它，并在数秒内树杀服务器，因此 `dsh web` 永远不会比它的窗口活得更久。
- 服务器 stdout 以 `[dsh web]` 前缀转发到本进程 stdout；在终端里运行 `electron .` 可同时看到两个流。打包版除 Electron 自身的 `userData` 与 harness 正常的 `$DSH_HOME`/workspace 文件外不写任何磁盘内容。
- 会话与 workspace 语义归 CLI 所有：调用目录是默认项目和 Workspace 根，`$DSH_HOME/config.yaml` 照常生效。从开始菜单快捷方式启动打包版时 cwd 是 shell 的目录，因此建议从项目目录启动应用，或在 GUI 里选择 Workspace。

## 打包

```sh
pnpm --filter @deepseek-ai/dsh-desktop dist        # NSIS installer + portable exe under release/
pnpm --filter @deepseek-ai/dsh-desktop dist:dir    # unpacked dir only, for a quick smoke
```


`dist` 先构建仓库（`build:lib` + `build:web`），再用 `pnpm run deploy:closure` 物化自包含 web 闭包（`dsh-desktop-closure` deploy root，与 `python/sdk-runtime` 同一模式），最后用 `electron-builder.yml` 运行 electron-builder。打包版不需要 Node、不需要 `dsh`、也不需要检出目录：启动器的嵌入闭包分支在 Electron-as-Node（`ELECTRON_RUN_AS_NODE=1`）下运行捆绑的 CLI，并带 `--expose-internals`——harness 的 HMR 服务需要 Node 内部模块，而 `node-addon-require-builtin` 回退在 Electron 的 V8 下不可用。闭包中的原生插件是 N-API，无需针对 Electron 重新编译；`deploy/**` 与 `lib/reaper.js` 从 asar 解包，供 run-as-Node 子进程读取。

图标（`build/icon.png`、`build/tray-icon.png`）由 `pnpm run icons` 从 `apps/web/public/favicon.svg` 栅格化生成并提交；favicon 变化时重新生成。

## 测试

`tests/launcher.spec.ts` 覆盖纯启动器逻辑——命令解析、就绪行解析与就绪轮询——无密钥、不启动 Electron。

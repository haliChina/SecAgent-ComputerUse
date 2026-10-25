# 参考：报错分诊与踩坑恢复

## 第一步永远是 doctor

动作失败先 `doctor`：逐项验证操作系统、系统库加载、屏幕探针、UIA/PowerShell、浏览器扩展桥、Python、OmniParser、发光标记，失败项带修复建议。

## 常见报错 → 出路

| 报错/现象 | 含义与出路 |
|---|---|
| `Cannot find function 'xxx'`（系统库） | koffi 声明失败：重装插件（0.7.4+ 已修归属+懒防御） |
| `浏览器扩展未连接` | 扩展没配对：设置控制台「浏览器扩展桥」卡片看端口+配对码；chrome://extensions 开发者模式加载 extension/ |
| `OmniParser 响应超时` | 服务在跑但 CPU 推理慢（无 CUDA 属预期）：调大超时或 backend="uia"；无 CUDA 机器 doctor 会建议不启用 |
| `服务未在超时内就绪` | 启动失败：看 /health 的 selfcheck 字段；`SELF-CHECK FAILED` = 模型加载假成功（0.7.6 起启动当场暴露） |
| inspect 元素为 0 + 前台警告 | 前台是 SecAgent 宿主自身：先 focus 目标应用 |
| 点击无反应（管理员目标） | 提权窗口 UIA 取不到：向用户说明需宿主同权限 |
| 图标/自绘 UI 无元素 | route-fallback.md 的目测交叉核对 |

## 实机踩坑集（已修，遇同类现象先想到这些）

- 睡着的桌宠换皮肤仍半透明 → DP 插件 0.5.6（换肤唤醒+叠暗罩）。
- 计时狂走/CallChip 图标叠加 → 宿主 UI 层，装最新宿主 exe。
- 打字中文乱码 → 0.7.1 起 SendInput（wScan 16 位）；旧版请升级。
- QQ音乐类 UIA 0 元素 → 0.6.0 起超时分诊+auto 降级（不再整链路失败）。

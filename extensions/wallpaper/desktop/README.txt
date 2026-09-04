# 壁纸包使用说明

手机和电脑共用一套图，图只维护一份（`../extensions/wallpaper/assets/`）。

## 手机端（已生效）

`../extensions/wallpaper/` 是一个 dsh-mobile 扩展，DSH 下次启动（或扩展热加载）后在手机端出现「壁纸」页面：
- 内置 · 深海极光（`assets/wallpaper-builtin.svg`，直接改这个文件就换内置图）
- 粘贴任意 https 图片地址
- 恢复默认
选择立即生效并记在手机浏览器本地。想加第二张内置图：把文件丢进 `assets/` 即可被插件服务（带版本绑定，防缓存）。

## 电脑端（需装 Stylus）

1. 电脑浏览器装 Stylus 扩展。
2. Stylus → 从文件导入 `dsh-wallpaper.user.css`（本目录）。
3. 默认就是内置深海极光；想换图就改样式变量 `bg-url` 的值。
4. 只在 `127.0.0.1:3080`（本地 DSH）生效，不影响别的网站。

## 为什么电脑端不直接做进插件

dsh-mobile 的扩展体系只管手机端（mobile.js 跑在手机浏览器）；
电脑端 DSH 的 UI 由 DSH 本体的 `dsh.client` 插件机制拥有，外部包要复刻整套构建才能注入，
杀鸡用不着牛刀——用户样式 5 分钟搞定，图还和手机端同源。

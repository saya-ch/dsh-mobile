# 壁纸包

手机和电脑共用一套图，图只维护一份：`mobile/assets/wallpaper-builtin.png`。

## 手机端

`mobile/` 是一个标准 dsh-mobile 扩展。插件启动时会自动播种到 `$DSH_HOME/mobile-access/extensions/wallpaper/`（已存在则永不覆盖；删掉该目录可恢复默认）。手机端出现「壁纸」页：

- 内置壁纸（`assets/wallpaper-builtin.png`，换文件即换内置图）
- 粘贴任意 https 图片地址
- 恢复默认

选择立即生效并记在手机浏览器本地。加第二张内置图：把文件丢进 `assets/`（单文件 8 MiB、总共 32 MiB 以内）。

## 电脑端

`desktop/dsh-wallpaper.user.css` 是 Stylus 用户样式，内置图已内联（data URI，与手机端同一张图同一时刻生成）：

1. 电脑浏览器装 Stylus 扩展。
2. 从文件导入 `dsh-wallpaper.user.css`。
3. 默认就是内置图；改样式变量 `bg-url` 可换自己的图。
4. 只在本地 DSH（`127.0.0.1:3080`）生效，不影响别的网站。

## 换内置图

1. 把新图存为 `mobile/assets/wallpaper-builtin.png`（或改名并同步改 `mobile/mobile.js` 里的 `assetUrl`）。
2. 重新生成桌面样式里的内联图（见本包维护说明），保持两端同源。
3. 手机端已有选择不受影响（内置项指向新图）。

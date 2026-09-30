# iOS 图标与中文后备字体

`AppIcon.svg` 是应用图标源文件，导出的 PNG 位于 iOS 工程资源目录。

`NotoSansCJKsc-Regular.otf` 来自 Noto CJK 官方仓库：
https://github.com/notofonts/noto-cjk/blob/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf

字体遵循随附 `OFL.txt` 的 SIL Open Font License 1.1。iOS 构建脚本仅将其复制进 iOS 网页资源目录；iOS 使用随包中文字体，避免模拟器或不同系统的字体回退异常。网页版和安卓不会下载此文件。

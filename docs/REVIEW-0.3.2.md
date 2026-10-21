# 0.3.2 图标更新

参考 /Applications/Trae.app 中本机 Trae.icns 的白底、几何轮廓与双眼语言重新设计。双向箭头融入外框，薄荷绿下半框表达账号切换，保留独立应用辨识度。

源文件 ui/icon.svg；生成 ui/icon.png、build/TraeSwitch.iconset 全尺寸与 build/icon.icns。侧栏、Dock 与打包图标沿用同一来源，未添加依赖。已检查 1024px 渲染与小尺寸图标，格式检查通过。纯视觉与版本更新，不变更业务逻辑。

0.3.2 macOS arm64 安装包采用 ad-hoc 签名，未公证。构建脚本包含 codesign deep strict 和 hdiutil verify 校验。

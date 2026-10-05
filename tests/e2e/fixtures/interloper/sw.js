// sw.js —— E2E 冒烟夹具的存在性心跳。
//
// 为什么需要这个文件：Chromium 的 --load-extension 只接受「有 background 的扩展」
// 才会在 Playwright 的 serviceWorkers() 里暴露 worker，而 tests/e2e-smoke.js 正是
// 通过每个 worker 的 chrome.runtime.getManifest().name 来发现夹具扩展的 ID
// （夹具的 ID 由 Chromium 随机生成，无法预知，因此不能硬编码扩展页面 URL）。
// 这里刻意【不】做任何代理写入 —— 接管动作由测试在夹具页面的上下文中显式发起，
// 使「何时接管」完全可控、可断言。
'use strict';

// 冷启动即对齐一次无副作用的自我标识，便于排障时确认夹具确实被加载。
chrome.runtime.onInstalled.addListener(function (details) {
  console.log('[e2e-interloper] installed:', details && details.reason);
});

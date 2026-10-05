#!/usr/bin/env node
// tools/package.js —— 可复现的发布打包脚本（A3）
// 运行：node tools/package.js
//
// 背景：此前直接把整个仓库目录当扩展加载/打包，tests/（约 300 KB，含 child_process
//   用法）、.github/、CHANGELOG.md 等非运行文件会一并进入发布产物，扩大包体与攻击面。
// 本脚本从 manifest.json 读取版本号，把【仅运行时需要的文件】复制到
//   dist/easy-proxy-by-ds4-<version>/，并打印产物清单供人工核对。
// 可复现性：产物内容完全由文件清单决定，清单与 manifest.version 进 git，任何人在
//   任意机器上对同一提交执行本脚本都得到逐字节相同的产物（纯复制，无构建步骤）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const version = manifest.version;

// 运行时文件清单 = manifest 直接或间接引用的文件 + manifest 自身。
// 新增源文件时必须同步此清单（清单缺失会在下方存在性校验中报错）。
const RUNTIME_FILES = [
  "manifest.json",
  "settings.js",
  "background.js",
  "popup.html",
  "popup.js",
  "icon-red-16.png",
  "icon-red-32.png",
  "icon-red-48.png",
  "icon-red-128.png",
  "icon-green-16.png",
  "icon-green-32.png",
  "icon-green-48.png",
  "icon-green-128.png"
];

// 校验：manifest 引用到的每个文件都必须在清单里（防止加文件忘了同步）
const referenced = new Set();
referenced.add(manifest.background && manifest.background.service_worker);
referenced.add(manifest.action && manifest.action.default_popup);
for (const k of Object.keys(manifest.icons || {})) referenced.add(manifest.icons[k]);
for (const k of Object.keys((manifest.action && manifest.action.default_icon) || {})) {
  referenced.add(manifest.action.default_icon[k]);
}
const missing = [...referenced].filter(f => f && !RUNTIME_FILES.includes(f));
if (missing.length) {
  console.error("错误：manifest 引用的文件未包含在打包清单中：" + missing.join(", "));
  process.exit(1);
}

const dest = path.join(root, "dist", "easy-proxy-by-ds4-" + version);
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

console.log("打包 easy-proxy-by-ds4 v" + version + " -> " + path.relative(root, dest));
for (const f of RUNTIME_FILES) {
  const src = path.join(root, f);
  if (!fs.existsSync(src)) {
    console.error("错误：清单中的文件不存在：" + f);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(dest, f));
  console.log("  + " + f + "  (" + fs.statSync(src).size + " B)");
}

// 刻意排除（A3）：tests/、.github/、.editorconfig、CHANGELOG.md、README.md、
//   SECURITY.md、LICENSE、package.json、eslint.config.mjs、tools/、node_modules/
console.log("");
console.log("已排除非运行文件：tests/、.github/、docs、元文件与依赖目录。");
console.log("产物就绪：" + path.relative(root, dest));

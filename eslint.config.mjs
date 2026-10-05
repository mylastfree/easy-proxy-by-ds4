// eslint.config.mjs —— ESLint 平面配置（A1）
// 原则：只开启「能真实拦住缺陷」的核心规则，不引入与既有代码风格冲突的
//   格式类规则（引号风格、分号等交给人工评审 / Prettier，避免一次性
//   重写全部源码、污染 git blame）。本扩展运行在三类环境：
//   · settings.js：纯函数，不得引用任何 chrome.*（由测试结构断言守住）
//   · background.js：MV3 Service Worker（chrome 全局 + importScripts）
//   · popup.js：弹窗页面（window / document / chrome 全局）
//   · tests/**：Node.js（require / process / __dirname）
export default [
  {
    ignores: ["node_modules/", "dist/", ".worktrees/"]
  },
  {
    // 本配置文件自身是 ES Module
    files: ["**/*.mjs"],
    languageOptions: { sourceType: "module" }
  },
  {
    // 源码与测试均为 CommonJS（settings.js/background.js/popup.js/tests/**）
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        chrome: "readonly",
        importScripts: "readonly",
        window: "readonly",
        document: "readonly",
        self: "readonly",
        globalThis: "readonly",
        console: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        TextEncoder: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly"
      }
    },
    rules: {
      // 真实缺陷拦截
      "no-undef": "error",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-unreachable": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-fallthrough": "error",
      "no-redeclare": "error",
      "no-self-compare": "error",
      "no-async-promise-executor": "error",
      "require-atomic-updates": "off", // 与本仓库的串行队列设计语义冲突（队列本身保证原子性）
      "eqeqeq": ["error", "smart"]
    }
  },
  {
    // 工具脚本：Node 环境（tools/package.js 使用 __dirname / process）
    files: ["tools/**/*.js"],
    languageOptions: {
      globals: {
        require: "readonly",
        module: "readonly",
        process: "readonly",
        __dirname: "readonly"
      }
    }
  },
  {
    // 测试文件：Node 环境 + 允许空的捕获（探针模式常见）
    files: ["tests/**/*.js"],
    languageOptions: {
      globals: {
        require: "readonly",
        module: "readonly",
        process: "readonly",
        __dirname: "readonly",
        TextEncoder: "readonly"
      }
    }
  }
];

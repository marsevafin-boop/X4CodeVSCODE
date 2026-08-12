import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** Сборка extension host: Node.js, CommonJS. SDK не бандлим — он спавнит CLI из
 *  собственного пакета и должен остаться обычной зависимостью в node_modules. */
const extensionCtx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["vscode", "@anthropic-ai/claude-agent-sdk"],
});

/** Сборка webview: браузерный бандл + CSS (импортируется из index.tsx). */
const webviewCtx = await esbuild.context({
  entryPoints: ["webview/index.tsx"],
  outfile: "dist/webview.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: true,
  loader: { ".css": "css" },
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  console.log("[esbuild] watching…");
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
  console.log("[esbuild] build done");
}

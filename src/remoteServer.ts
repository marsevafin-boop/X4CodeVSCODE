/**
 * Удалённый доступ к чату (мобильный клиент): HTTP отдаёт тот же React-бандл
 * webview в «мобильном режиме», WebSocket гоняет тот же протокол
 * WebviewToHost/HostToWebview. Модуль не зависит от `vscode` — его можно
 * поднять и проверить обычным node-скриптом.
 *
 * Безопасность: сервер по сути даёт shell на Mac через агентов, поэтому
 * каждый запрос обязан нести токен в пути (/t/<token>/…), а наружу порт
 * не открывается — доступ извне только через Tailscale (WireGuard).
 */
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

export interface RemoteClient {
  readonly id: string;
  send(msg: unknown): void;
}

export interface RemoteServerOptions {
  port: number;
  /** Интерфейс для listen; по умолчанию все (0.0.0.0) — снаружи защищает Tailscale. */
  host?: string;
  token: string;
  /** Папка dist с webview.js / webview.css. */
  distDir: string;
  /** Папка media с icon.svg / remote-theme.css. */
  mediaDir: string;
  onMessage: (client: RemoteClient, msg: unknown) => void;
  onConnect?: (client: RemoteClient) => void;
  onDisconnect?: (client: RemoteClient) => void;
}

export function generateToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
};

export class RemoteServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Map<WebSocket, RemoteClient>();

  constructor(private readonly opts: RemoteServerOptions) {}

  get clientCount(): number {
    return this.clients.size;
  }

  get port(): number {
    const a = this.server?.address();
    return typeof a === "object" && a ? a.port : this.opts.port;
  }

  get running(): boolean {
    return this.server !== null;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleHttp(req, res));
      const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
      server.on("upgrade", (req, socket, head) => {
        const route = this.route(req.url ?? "");
        if (!route.ok || route.rest !== "ws") {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
      });
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(this.opts.port, this.opts.host ?? "0.0.0.0", () => {
        server.off("error", onError);
        this.server = server;
        this.wss = wss;
        resolve(this.port);
      });
    });
  }

  stop() {
    for (const ws of this.clients.keys()) {
      try {
        ws.close(1001, "server stopping");
      } catch {
        // уже закрыт
      }
    }
    this.clients.clear();
    this.wss?.close();
    this.server?.close();
    this.wss = null;
    this.server = null;
  }

  /** Всем подключённым клиентам — как post() в две поверхности VS Code. */
  broadcast(msg: unknown) {
    if (this.clients.size === 0) return;
    const data = JSON.stringify(msg);
    for (const ws of this.clients.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  // ---------- маршрутизация ----------

  /** /t/<token>/<rest> → проверка токена (постоянное время) и остаток пути. */
  private route(url: string): { ok: boolean; rest: string } {
    const m = /^\/t\/([A-Za-z0-9]+)\/?([^?#]*)/.exec(url);
    if (!m) return { ok: false, rest: "" };
    const given = Buffer.from(m[1]);
    const real = Buffer.from(this.opts.token);
    const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
    return { ok, rest: m[2] ?? "" };
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url ?? "/";
    const route = this.route(url);
    if (!route.ok) {
      res.writeHead(url === "/" || url === "/health" ? 200 : 401, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        url === "/health"
          ? JSON.stringify({ ok: true, clients: this.clients.size })
          : "Agent Hub: откройте ссылку с токеном из команды «Agent Hub: Мобильный доступ».",
      );
      return;
    }
    const base = `/t/${this.opts.token}/`;
    const rest = route.rest;
    const headers = { "Cache-Control": "no-store" } as Record<string, string>;

    if (rest === "" || rest === "index.html") {
      res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
      res.end(renderRemoteHtml(base));
      return;
    }
    if (rest === "manifest.webmanifest") {
      res.writeHead(200, { ...headers, "Content-Type": "application/manifest+json; charset=utf-8" });
      res.end(
        JSON.stringify({
          name: "Agent Hub",
          short_name: "Agent Hub",
          start_url: base,
          scope: base,
          display: "standalone",
          orientation: "portrait",
          background_color: "#181818",
          theme_color: "#181818",
          icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
        }),
      );
      return;
    }
    if (rest === "sw.js") {
      res.writeHead(200, { ...headers, "Content-Type": "text/javascript; charset=utf-8" });
      res.end("self.addEventListener('fetch', () => {});\n");
      return;
    }
    if (rest === "health") {
      res.writeHead(200, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, clients: this.clients.size }));
      return;
    }
    // Статика: только известные файлы из dist/ и media/ — без обхода путей.
    const files: Record<string, string> = {
      "webview.js": path.join(this.opts.distDir, "webview.js"),
      "webview.js.map": path.join(this.opts.distDir, "webview.js.map"),
      "webview.css": path.join(this.opts.distDir, "webview.css"),
      "remote-theme.css": path.join(this.opts.mediaDir, "remote-theme.css"),
      "icon.svg": path.join(this.opts.mediaDir, "icon.svg"),
    };
    const file = files[rest];
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      ...headers,
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    });
    fs.createReadStream(file).pipe(res);
  }

  private onSocket(ws: WebSocket) {
    const client: RemoteClient = {
      id: crypto.randomBytes(4).toString("hex"),
      send: (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    this.clients.set(ws, client);
    this.opts.onConnect?.(client);
    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return; // не-JSON игнорируем
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { type?: unknown }).type !== "string"
      ) {
        return;
      }
      this.opts.onMessage(client, parsed);
    });
    ws.on("close", () => {
      this.clients.delete(ws);
      this.opts.onDisconnect?.(client);
    });
    ws.on("error", () => ws.close());
  }
}

/**
 * Страница мобильного клиента: тот же бандл + шим вместо acquireVsCodeApi.
 * Входящие сообщения хоста подкладываются через window.postMessage — так
 * App.tsx получает их тем же обработчиком, что и внутри VS Code.
 */
export function renderRemoteHtml(base: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="ru" class="remote">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content">
  <meta name="theme-color" content="#181818">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <link rel="manifest" href="${base}manifest.webmanifest">
  <link rel="icon" href="${base}icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${base}remote-theme.css">
  <link rel="stylesheet" href="${base}webview.css">
  <title>Agent Hub</title>
</head>
<body>
  <div id="ah-conn" hidden></div>
  <div id="root"></div>
  <script>
  (function () {
    window.__AGENT_HUB_REMOTE__ = true;
    var base = ${JSON.stringify(base)};
    var wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + base + "ws";
    var ws = null, queue = [], openedOnce = false, timer = null;
    var conn = document.getElementById("ah-conn");
    function status(text) {
      conn.textContent = text;
      conn.hidden = !text;
    }
    function connect() {
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
      ws = new WebSocket(wsUrl);
      ws.onopen = function () {
        status("");
        var pending = queue; queue = [];
        pending.forEach(function (m) { ws.send(m); });
        // Переподключение: заново запросить полное состояние у хоста.
        if (openedOnce) ws.send(JSON.stringify({ type: "ready" }));
        openedOnce = true;
      };
      ws.onmessage = function (e) {
        try { window.postMessage(JSON.parse(e.data), "*"); } catch (_) {}
      };
      ws.onclose = function () {
        status("Нет связи с компьютером — переподключаюсь…");
        clearTimeout(timer);
        timer = setTimeout(connect, 2000);
      };
      ws.onerror = function () { try { ws.close(); } catch (_) {} };
    }
    window.acquireVsCodeApi = function () {
      return {
        postMessage: function (msg) {
          var s = JSON.stringify(msg);
          if (ws && ws.readyState === 1) ws.send(s); else queue.push(s);
        }
      };
    };
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") connect();
    });
    connect();
    if ("serviceWorker" in navigator) {
      try { navigator.serviceWorker.register(base + "sw.js").catch(function () {}); } catch (_) {}
    }
  })();
  </script>
  <script src="${base}webview.js"></script>
</body>
</html>`;
}

// ---------- адреса ----------

/** IPv4-адреса локальных интерфейсов (Wi-Fi/LAN) без loopback. */
export function lanAddresses(): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal) out.push({ name, address: i.address });
    }
  }
  return out;
}

const TAILSCALE_BINS = [
  "tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
];

function runTailscale(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= TAILSCALE_BINS.length) {
        resolve({ ok: false, out: "", err: "tailscale не найден" });
        return;
      }
      const bin = TAILSCALE_BINS[i++];
      execFile(bin, args, { timeout: 8000 }, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          tryNext();
          return;
        }
        resolve({ ok: !err, out: String(stdout), err: String(stderr || err?.message || "") });
      });
    };
    tryNext();
  });
}

export interface TailscaleInfo {
  ip?: string;
  /** MagicDNS-имя машины без точки на конце, например mac.tail1234.ts.net */
  dnsName?: string;
  /** Tailscale Serve уже проксирует HTTPS на наш порт. */
  serveHttps?: boolean;
}

export async function tailscaleInfo(port: number): Promise<TailscaleInfo | null> {
  const st = await runTailscale(["status", "--json"]);
  if (!st.ok) return null;
  try {
    const j = JSON.parse(st.out) as {
      Self?: { TailscaleIPs?: string[]; DNSName?: string };
      BackendState?: string;
    };
    if (j.BackendState && j.BackendState !== "Running") return null;
    const info: TailscaleInfo = {
      ip: j.Self?.TailscaleIPs?.find((a) => a.includes(".")),
      dnsName: j.Self?.DNSName?.replace(/\.$/, ""),
    };
    const serve = await runTailscale(["serve", "status"]);
    info.serveHttps = serve.ok && serve.out.includes(`127.0.0.1:${port}`);
    return info;
  } catch {
    return null;
  }
}

/** Включить HTTPS-прокси Tailscale Serve (только внутри tailnet) на наш порт. */
export async function enableTailscaleServe(port: number): Promise<{ ok: boolean; message: string }> {
  const r = await runTailscale(["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
  return { ok: r.ok, message: (r.out + "\n" + r.err).trim() };
}

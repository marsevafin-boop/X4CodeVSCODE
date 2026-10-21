import { spawn } from "node:child_process";
import { isIP } from "node:net";

export interface ServerConnection {
  host: string;
  user?: string;
  protocol?: "ssh" | "sftp" | "ftp";
  port?: number;
}

export function buildServerEnvironment(secretEnv: Record<string, string>, password?: string): Record<string, string> {
  const selected = password ?? secretEnv.AGENT_HUB_SERVER_PASSWORD ?? secretEnv.SSHPASS ?? secretEnv.LFTP_PASSWORD ?? "";
  // Empty values deliberately override passwords inherited from another project.
  return { ...secretEnv, AGENT_HUB_SERVER_PASSWORD: selected, SSHPASS: selected, LFTP_PASSWORD: selected };
}

function validateConnection(connection: ServerConnection) {
  if (!connection || typeof connection.host !== "string" || !connection.host || connection.host.length > 253) {
    throw new Error("Некорректный хост сервера.");
  }
  const bracketed = connection.host.startsWith("[") && connection.host.endsWith("]");
  const host = bracketed ? connection.host.slice(1, -1) : connection.host;
  const ipv6 = isIP(host) === 6;
  if ((bracketed && !ipv6) || (!ipv6 && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host))) {
    throw new Error("Некорректный хост сервера: укажите адрес или SSH-алиас без опций и пути.");
  }
  const user = connection.user;
  if (user !== undefined && (typeof user !== "string" || (user !== "" && !/^[a-zA-Z0-9_][a-zA-Z0-9_.@\\-]*\$?$/.test(user)))) {
    throw new Error("Некорректный логин сервера.");
  }
  const port = connection.port;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("Некорректный порт сервера: число от 1 до 65535.");
  }
  const protocol = connection.protocol ?? "ssh";
  if (protocol !== "ssh" && protocol !== "sftp" && protocol !== "ftp") throw new Error("Неизвестный протокол сервера.");
  return { host, user, port, protocol, ipv6 };
}

/** Public connection parameters only: passwords are supplied to the process via env. */
export function buildSshCommand(
  connection: ServerConnection,
  authentication: "password" | "key",
  remoteCommand?: string,
): { command: string; args: string[]; target: string } {
  const { host, user, port, protocol, ipv6 } = validateConnection(connection);
  if (protocol === "ftp") throw new Error("Эта команда поддерживает только SSH и SFTP.");
  const isSftp = protocol === "sftp";
  const targetHost = ipv6 && isSftp ? `[${host}]` : host;
  const target = user ? `${user}@${targetHost}` : targetHost;
  const withPassword = authentication === "password";
  const auth = withPassword
    ? ["BatchMode=no", "PreferredAuthentications=password,keyboard-interactive", "PubkeyAuthentication=no", "PasswordAuthentication=yes", "KbdInteractiveAuthentication=yes", "NumberOfPasswordPrompts=1"]
    : ["BatchMode=yes", "PreferredAuthentications=publickey", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no"];
  const options = [
    ...auth, "ConnectTimeout=8", "StrictHostKeyChecking=accept-new",
    "ControlMaster=no", "ControlPath=none",
  ].flatMap((option) => ["-o", option]);
  // An absent port must retain Port from the user's SSH config/alias.
  const portArgs = port !== undefined ? [isSftp ? "-P" : "-p", String(port)] : [];
  const args = [...options, ...portArgs, ...(isSftp ? ["-b", "-"] : []), target,
    ...(!isSftp && remoteCommand !== undefined ? [remoteCommand] : [])];
  const binary = isSftp ? "sftp" : "ssh";
  return withPassword
    ? { command: "sshpass", args: ["-e", binary, ...args], target }
    : { command: binary, args, target };
}

/** POSIX shell example for agent instructions; connection targets are always quoted. */
export function formatSshCommand(
  connection: ServerConnection,
  authentication: "password" | "key",
  remoteCommand?: string,
): string {
  const { command, args, target } = buildSshCommand(connection, authentication, remoteCommand);
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  return [command, ...args.map((arg) => arg !== target && /^[a-zA-Z0-9_./:=,+-]+$/.test(arg) ? arg : quote(arg))].join(" ");
}

type ProbeResult = { code: number; out: string; err: string; timedOut: boolean; unavailable: boolean };

function runProbe(command: string, args: string[], password?: string, stdin = ""): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number, unavailable = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err, timedOut, unavailable });
    };
    try {
      const env = { ...process.env, ...buildServerEnvironment({}, ""), ...(password ? { SSHPASS: password } : {}) };
      const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.on("data", (chunk: Buffer) => { out = (out + chunk.toString()).slice(-65536); });
      child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk.toString()).slice(-65536); });
      child.on("error", (error: NodeJS.ErrnoException) => finish(127, error.code === "ENOENT"));
      child.on("close", (code: number | null) => finish(code ?? 1));
      // A child rejecting credentials may close stdin before our batch is written.
      child.stdin.on("error", () => {});
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch {
          // Timeout still resolves safely if the OS rejects the signal.
        }
        finish(124);
      }, 15000);
      child.stdin.end(stdin);
    } catch (error) {
      finish(127, (error as NodeJS.ErrnoException)?.code === "ENOENT");
    }
  });
}

export async function testServerConnection(
  connection: ServerConnection,
  password: string | undefined,
): Promise<{ ok: boolean; message: string }> {
  const fail = (message: string) => ({ ok: false, message });
  let validated: ReturnType<typeof validateConnection>;
  try { validated = validateConnection(connection); }
  catch (error) { return fail(error instanceof Error ? error.message : "Некорректные настройки сервера."); }
  const { host, user, port, protocol, ipv6 } = validated;
  if (password !== undefined && (typeof password !== "string" || password.includes("\0"))) return fail("Некорректный пароль сервера.");

  if (protocol === "ftp") {
    const hostPort = `${ipv6 ? `[${host}]` : host}:${port ?? 21}`;
    const escape = (text: string) => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/\v/g, "\\v");
    const config = [
      `url = "ftp://${hostPort}/"`,
      `user = "${escape(user || "anonymous")}:${escape(password ?? "")}"`,
      "list-only", "connect-timeout = 8", "silent", "show-error",
    ].join("\n");
    const result = await runProbe("curl", ["--disable", "--max-time", "15", "-K", "-"], undefined, config);
    if (result.timedOut || result.code === 28) return fail(`FTP ${hostPort} — таймаут соединения.`);
    if (result.unavailable) return fail("Для проверки FTP нужен curl.");
    if (result.code === 67) return fail(`FTP ${hostPort} — сервер отверг логин/пароль.`);
    if (result.code === 6 || result.code === 7) return fail(`FTP ${hostPort} — хост не найден или соединение отклонено.`);
    if (result.code !== 0) return fail(`FTP ${hostPort} — ошибка соединения (код ${result.code}).`);
    const entries = result.out.split("\n").filter(Boolean).length;
    return { ok: true, message: `FTP ${hostPort} — соединение и логин OK (в корне записей: ${entries})` };
  }

  const isSftp = protocol === "sftp";
  const withPassword = Boolean(password);
  const { command, args, target } = buildSshCommand(connection, withPassword ? "password" : "key", isSftp ? undefined : "echo AGENT_HUB_OK");
  const binary = isSftp ? "sftp" : "ssh";
  const result = await runProbe(command, args, withPassword ? password : undefined, isSftp ? "bye\n" : "");
  if (result.timedOut) return fail(`${target} — таймаут соединения: хост недоступен или порт закрыт.`);
  if (result.unavailable) return fail(withPassword ? "Для проверки по паролю нужны sshpass и SSH-клиент." : `Для проверки нужен ${binary}.`);
  const marker = result.out.split(/\r?\n/).some((line) => line.trim() === "AGENT_HUB_OK");
  if (result.code === 0 && (isSftp || marker)) {
    return { ok: true, message: `${protocol.toUpperCase()} ${target} — доступ ${withPassword ? "по паролю" : "по SSH-ключу"}` };
  }
  // External diagnostics may echo a credential or its escaped representation.
  // Return fixed messages, never raw stdout/stderr or spawn exception text.
  if (/connection timed out|operation timed out/i.test(result.err)) {
    return fail(`${target} — таймаут соединения: хост недоступен или порт закрыт.`);
  }
  if (/host key verification failed|remote host identification has changed/i.test(result.err)) {
    return fail(`${target} — не пройдена проверка ключа сервера (host key). Проверьте отпечаток сервера и known_hosts.`);
  }
  if (/connection refused|no route to host|network is unreachable|could not resolve hostname|name or service not known/i.test(result.err)) {
    return fail(`${target} — хост не найден или соединение отклонено/недоступно.`);
  }
  if (withPassword && (result.code === 5 || /permission denied|authentication failed/i.test(result.err))) {
    return fail(`${target} — сервер отверг логин/пароль.`);
  }
  return fail(`${target} — не подключилось ${withPassword ? "по паролю" : "по ключу"} (код ${result.code}).`);
}

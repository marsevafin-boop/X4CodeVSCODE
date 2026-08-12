# Agent Hub — X4Code для VS Code

Оболочка над CLI-агентами в одном чате VS Code: **Claude** (Agent SDK, подписка
Claude Max) и **GPT (Codex CLI**, аккаунт ChatGPT) — с проектами, общей памятью,
подтверждениями операций и историей сессий.

<p align="center">
  <a href="https://github.com/marsevafin-boop/X4CodeVSCODE/releases/latest/download/agent-hub-darwin-arm64.vsix">
    <img src="https://img.shields.io/badge/⬇%20Скачать%20для%20macOS-Apple%20Silicon-0A84FF?style=for-the-badge&logo=apple&logoColor=white" alt="Скачать для macOS (Apple Silicon)">
  </a>
  &nbsp;
  <a href="https://github.com/marsevafin-boop/X4CodeVSCODE/releases/latest/download/agent-hub-win32-x64.vsix">
    <img src="https://img.shields.io/badge/⬇%20Скачать%20для%20Windows-x64-2D7D46?style=for-the-badge&logoColor=white" alt="Скачать для Windows (x64)">
  </a>
</p>

## Установка

1. Скачайте `.vsix` под свою систему кнопкой выше (все версии — в
   [Releases](https://github.com/marsevafin-boop/X4CodeVSCODE/releases)).
2. Установите:
   - терминал: `code --install-extension agent-hub-<платформа>.vsix`
   - или из VS Code: **Extensions → «…» → Install from VSIX…**
3. Перезапустите VS Code — в боковой панели появится иконка чата **Agent Hub**.

### Требования

- Установленные и залогиненные CLI-агенты на машине, где работает extension host
  (при Remote-SSH — на сервере):
  - `claude` — [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (подписка Claude Max);
  - `codex` — [Codex CLI](https://github.com/openai/codex) (аккаунт ChatGPT).
- В окружении **не должно быть** `ANTHROPIC_API_KEY` — иначе биллинг Claude
  уйдёт в pay-as-you-go вместо подписки.

## Возможности

- 💬 Чат со стримингом, переключатель Claude ⇄ GPT, очередь сообщений «вдогонку»;
- 📁 Проекты: папка, GitHub-репозиторий, ветка, сервер (host/логин, пароль — в
  Keychain), проверка SSH-соединения из настроек;
- 🛡 Карточки подтверждений операций + allowlist безопасных команд; режимы
  acceptEdits / YOLO (dangerously-skip-permissions) с переключателем в статус-строке;
- ❓ Вопросы агента (AskUserQuestion) — карточкой с кнопками-вариантами;
- 🕘 История сессий на проект: возврат, удаление, восстановление после перезапуска;
- ✍ Журнал сессий в `docs/journal/` — общая память между агентами и машинами;
- 📎 Вложения: файлы, скриншоты из буфера (Cmd+V), drag&drop;
- 📊 Индикатор модели и точной занятости контекста (живой, по каждому шагу);
- ⚙ Все настройки внутри панели + экспорт/импорт всех настроек в JSON.

## Перенос настроек между машинами

⚙ → «⬇ Экспорт в JSON» на старой машине → «⬆ Импорт из JSON» на новой.
Пароли серверов не экспортируются (хранятся в системном Keychain) — задаются
заново. Пути проектов при переносе между ОС поправьте в JSON или через ⚙.

## Сборка из исходников

```bash
npm install
npm run build            # esbuild: dist/extension.js + dist/webview.js
npx vsce package --allow-missing-repository
```

Отладка: открыть папку в VS Code → F5 (Extension Development Host).

## Архитектура

`src/extension.ts` → `src/ChatViewProvider.ts` (протокол `src/shared/protocol.ts`,
журнал `src/journal.ts`) → бэкенды `src/agents/{claudeBackend,codexBackend}.ts`
за единым интерфейсом `AgentBackend`; UI — React в `webview/`.
Спецификация и замысел — `ai-dev-environment.md`.

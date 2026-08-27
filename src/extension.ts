import * as vscode from "vscode";
import { ChatViewProvider } from "./ChatViewProvider";

export function activate(context: vscode.ExtensionContext) {
  const provider = new ChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("agentHub.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("agentHub.addProject", () => provider.addProject()),
    vscode.commands.registerCommand("agentHub.setServerPassword", () =>
      provider.setServerPassword(),
    ),
    vscode.commands.registerCommand("agentHub.editProject", () => provider.editProject()),
    vscode.commands.registerCommand("agentHub.deleteProject", () =>
      provider.deleteActiveProject(),
    ),
    vscode.commands.registerCommand("agentHub.manageProjects", () => provider.manageProjects()),
    vscode.commands.registerCommand("agentHub.showContext", async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: "Claude", agent: "claude" as const },
          { label: "GPT (Codex)", agent: "codex" as const },
        ],
        { placeHolder: "Контекст какого агента показать?" },
      );
      if (pick) await provider.showContext(pick.agent);
    }),
    vscode.commands.registerCommand("agentHub.openFullView", () => provider.openFullView()),
    vscode.commands.registerCommand("agentHub.exportSettings", () => provider.exportSettings()),
    vscode.commands.registerCommand("agentHub.importSettings", () => provider.importSettings()),
  );
}

export function deactivate() {}

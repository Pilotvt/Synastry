export type MessageBoxType = "info" | "warning" | "error";

export type MessageBoxOptions = {
  type?: MessageBoxType;
  title?: string;
  message: string;
  detail?: string;
};

export async function showMessageBox(options: MessageBoxOptions): Promise<void> {
  const api = typeof window !== "undefined" ? window.electronAPI?.ui?.showMessageBox : undefined;
  if (api) {
    await api(options);
    return;
  }

  const text = [options.message, options.detail].filter(Boolean).join("\n\n");
  alert(text);
}


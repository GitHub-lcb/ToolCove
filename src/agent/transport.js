import { invoke } from '@tauri-apps/api/core';

export const isDesktop = typeof window === 'undefined' || !!window.__TAURI_INTERNALS__;

export async function desktopInvoke(command, args = {}) {
  if (!isDesktop) {
    const error = new Error(`该能力（${command}）为桌面版专属`);
    error.code = 'DESKTOP_ONLY';
    throw error;
  }
  try {
    return await invoke(command, args);
  } catch (error) {
    const wrapped = new Error(error instanceof Error ? error.message : String(error));
    wrapped.code = 'TAURI_COMMAND_FAILED';
    wrapped.command = command;
    throw wrapped;
  }
}

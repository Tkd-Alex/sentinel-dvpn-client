import type { API } from '../../preload/index'

declare global {
  interface Window {
    api: API
    electron: {
      ipcRenderer: {
        on(channel: string, listener: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void): void
        off(channel: string, ...args: unknown[]): void
        send(channel: string, ...args: unknown[]): void
        invoke(channel: string, ...args: unknown[]): Promise<unknown>
      }
    }
  }
}

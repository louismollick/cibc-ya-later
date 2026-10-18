import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/types'

const api: DesktopApi = {
  state: () => ipcRenderer.invoke('state'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  signIn: (card, password, fullHistory) =>
    ipcRenderer.invoke('sign-in', card, password, fullHistory),
  signOut: () => ipcRenderer.invoke('sign-out'),
  sync: () => ipcRenderer.invoke('sync'),
  downloadFullHistory: () => ipcRenderer.invoke('download-full-history'),
  cancelSync: () => ipcRenderer.invoke('cancel-sync'),
  submitCode: (code) => ipcRenderer.invoke('submit-code', code),
  connectApp: (label) => ipcRenderer.invoke('connect-app', label),
  revokeApp: (id) => ipcRenderer.invoke('revoke-app', id),
  closeAccount: (id) => ipcRenderer.invoke('close-account', id),
  copy: (text) => ipcRenderer.invoke('copy', text),
  exportShortcut: () => ipcRenderer.invoke('export-shortcut'),
  onChange: (listener) => {
    const handler = () => listener()
    ipcRenderer.on('state-changed', handler)
    return () => ipcRenderer.removeListener('state-changed', handler)
  },
}
contextBridge.exposeInMainWorld('cibc', api)

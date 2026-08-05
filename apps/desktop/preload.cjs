/**
 * The only things the shell adds to the page: a native folder picker, and
 * enough about itself for the UI to leave room for the window controls.
 *
 * Everything else the UI needs it gets from the engine's HTTP API, so the
 * same page works unchanged in a browser.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sdlcShell", {
  platform: process.platform,
  pickDirectory: () => ipcRenderer.invoke("sdlc:pick-directory"),
});

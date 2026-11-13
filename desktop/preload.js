'use strict';
// The only thing the desktop app adds to the page: window.antics = { desktop: true, version }, so the site can
// tell it runs in the antics app. No Node, no Electron and no messages to the app are exposed.

const { contextBridge } = require('electron');

const flag = '--antics-version=';
const arg = process.argv.find((a) => a.startsWith(flag));

contextBridge.exposeInMainWorld('antics', Object.freeze({ desktop: true, version: arg ? arg.slice(flag.length) : '' }));

import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './ui/App'
import { idb, initIfEmpty, isDocEmpty, maybeTakeCarried, roomId } from './state/doc'
import { startP2P, setPresence } from './state/net'
import { DEFAULT_PROJECT } from './packs'
import { initKeyboardPiano, initWebMidi } from './audio/input'
import { engine } from './audio/engine'
import { ui } from './state/store'

async function boot() {
  await idb.whenSynced

  // moving a project into a fresh share-room carries the FULL document across
  // the reload (lossless — sends, LFOs, macros, returns, automation and all)
  maybeTakeCarried()

  if (roomId) {
    // joining someone's room: give their state a moment to arrive before
    // assuming the room is brand new
    setTimeout(() => { if (isDocEmpty()) initIfEmpty(DEFAULT_PROJECT) }, 2500)
  } else {
    initIfEmpty(DEFAULT_PROJECT)
  }

  startP2P()
  initKeyboardPiano()
  initWebMidi()
  setPresence({ name: ui.userName, color: ui.userColor, view: ui.view, sel: null, ph: null })

  // browsers require a user gesture before audio — grab the first one
  const wake = () => { engine.ensureStarted() }
  window.addEventListener('pointerdown', wake, { once: true })
  window.addEventListener('keydown', wake, { once: true })
  // Reload only for EXTERNAL hash changes (pasting a room link, editing the
  // URL). Programmatic room transitions set __sfNav and reload themselves —
  // letting this fire too would double-reload and drop the carried project.
  window.addEventListener('hashchange', () => { if (!(window as any).__sfNav) location.reload() })

  createRoot(document.getElementById('root')!).render(<App />)
}

boot()

import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './ui/App'
import { idb, initIfEmpty, isDocEmpty, loadProject, maybeTakeCarriedProject, roomId } from './state/doc'
import { startP2P, setPresence } from './state/net'
import { DEFAULT_PROJECT } from './packs'
import { initKeyboardPiano, initWebMidi } from './audio/input'
import { engine } from './audio/engine'
import { ui } from './state/store'

async function boot() {
  await idb.whenSynced

  // moving a local project into a fresh share-room carries it across the reload
  const carried = maybeTakeCarriedProject()
  if (carried && isDocEmpty()) loadProject(carried, 'Start shared session')

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
  window.addEventListener('hashchange', () => location.reload())

  createRoot(document.getElementById('root')!).render(<App />)
}

boot()

// Left-side browser: searchable sound packs. Single click auditions, double
// click (or drag onto a track/slot) loads. Loops carry real MIDI patterns.

import React, { useState } from 'react'
import { INST_PRESETS, DRUM_KITS, MIDI_LOOPS } from '../packs'
import { engine } from '../audio/engine'
import { applyPreset, applyDrumKit, loadLoop, loadDemo, newProject, importProjectFile } from './actions'
import { exportProjectFile } from '../audio/render'
import { setUI, useUI } from '../state/store'

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bsection">
      <button className="bsection-head" onClick={() => setOpen(!open)}>
        <span className={`tri ${open ? 'open' : ''}`}>▸</span> {title}
      </button>
      {open && <div className="bsection-body">{children}</div>}
    </div>
  )
}

export function Browser() {
  const [q, setQ] = useState('')
  const query = q.toLowerCase()
  const match = (s: string) => !query || s.toLowerCase().includes(query)

  const presets = INST_PRESETS.filter(p => match(`${p.name} ${p.cat}`))
  const kits = DRUM_KITS.filter(k => match(k.name))
  const loops = MIDI_LOOPS.filter(l => match(`${l.name} ${l.cat}`))

  const cats = [...new Set(presets.map(p => p.cat))]

  return (
    <div className="browser">
      <div className="browser-search">
        <input
          placeholder="🔍 Search sounds…"
          value={q}
          onChange={e => setQ(e.target.value)}
          data-info="Search every pack: presets, kits and loops"
        />
      </div>
      <div className="browser-scroll">
        <Section title="Instruments">
          {cats.map(cat => (
            <div key={cat}>
              <div className="bcat">{cat}</div>
              {presets.filter(p => p.cat === cat).map(p => (
                <div
                  key={p.name}
                  className="bitem"
                  draggable
                  onDragStart={e => e.dataTransfer.setData('stg/preset', p.name)}
                  onClick={() => engine.audition(p.type, p.params)}
                  onDoubleClick={() => applyPreset(p)}
                  data-info="Click: audition · Double-click: load to selected track · Drag onto a track"
                >
                  <span className="bitem-icon">〰️</span>{p.name}
                </div>
              ))}
            </div>
          ))}
        </Section>

        <Section title="Drum Kits">
          {kits.map(k => (
            <div
              key={k.name}
              className="bitem"
              draggable
              onDragStart={e => e.dataTransfer.setData('stg/kit', k.name)}
              onClick={() => engine.audition('drum', k.params)}
              onDoubleClick={() => applyDrumKit(k.name)}
              data-info="Click: audition · Double-click: load kit · Drag onto a drum track"
            >
              <span className="bitem-icon">🥁</span>{k.name}
            </div>
          ))}
        </Section>

        <Section title="MIDI Loops">
          {(['Drums', 'Bass', 'Chords', 'Melody'] as const).map(cat => {
            const items = loops.filter(l => l.cat === cat)
            if (!items.length) return null
            return (
              <div key={cat}>
                <div className="bcat">{cat}</div>
                {items.map(l => (
                  <div
                    key={l.name}
                    className="bitem"
                    draggable
                    onDragStart={e => e.dataTransfer.setData('stg/loop', l.name)}
                    onDoubleClick={() => loadLoop(l)}
                    data-info="Double-click: drop into a free slot · Drag onto any clip slot or the timeline"
                  >
                    <span className="bitem-icon">{cat === 'Drums' ? '🥁' : '🎵'}</span>{l.name}
                  </div>
                ))}
              </div>
            )
          })}
        </Section>

        <Section title="Project">
          <button className="bbtn" onClick={loadDemo} data-info="Load the demo song (replaces the current project — undoable)">🎁 Load demo song</button>
          <button className="bbtn" onClick={newProject} data-info="Start fresh (undoable)">✨ New project</button>
          <button className="bbtn" onClick={exportProjectFile} data-info="Download the project as a shareable .json file">💾 Save project file</button>
          <button className="bbtn" onClick={importProjectFile} data-info="Load a saved .synthtagram.json project">📂 Import project</button>
        </Section>
      </div>
    </div>
  )
}

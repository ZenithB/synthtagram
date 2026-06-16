// Left-side browser: searchable sound packs. Single click auditions, double
// click (or drag onto a track/slot) loads. Loops carry real MIDI patterns;
// chord progressions render into the current project key.

import React, { useState } from 'react'
import { INST_PRESETS, DRUM_KITS, MIDI_LOOPS, PROGRESSIONS, progressionPitches } from '../packs'
import { engine } from '../audio/engine'
import { applyPreset, applyDrumKit, loadLoop, loadProgression, loadDemo, newProject, importProjectFile, pickAudioFile } from './actions'
import { exportProjectFile } from '../audio/render'
import { meta } from '../state/doc'
import { useY } from './hooks'
import { NOTE_NAMES } from '../theory'
import { instSchema } from '../audio/schema'
import { Icon } from './icons'
import { listUserPresets, removeUserPreset, isFavorite, toggleFavorite, useLib } from '../userlib'

function Star({ id }: { id: string }) {
  useLib()
  const fav = isFavorite(id)
  return (
    <button className={`bitem-star ${fav ? 'on' : ''}`} title={fav ? 'Unfavorite' : 'Favorite'}
      onClick={e => { e.stopPropagation(); toggleFavorite(id) }}>
      <Icon name={fav ? 'starFill' : 'star'} size={12} />
    </button>
  )
}

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

const LOOP_ICONS: Record<string, string> = { Drums: 'drum', Bass: 'bass', Chords: 'chord', Melody: 'note', Arps: 'arpUp' }

export function Browser() {
  const [q, setQ] = useState('')
  useY(meta)
  const query = q.toLowerCase()
  const match = (s: string) => !query || s.toLowerCase().includes(query)

  const presets = INST_PRESETS.filter(p => match(`${p.name} ${p.cat}`))
  const kits = DRUM_KITS.filter(k => match(k.name))
  const loops = MIDI_LOOPS.filter(l => match(`${l.name} ${l.cat}`))
  const progs = PROGRESSIONS.filter(p => match(`${p.name} ${p.numerals} ${p.mode} chords progression`))

  useLib()
  const cats = [...new Set(presets.map(p => p.cat))]
  const loopCats = [...new Set(loops.map(l => l.cat))]
  const rootPc = meta.get('root') ?? 9
  const auditionInst = INST_PRESETS.find(p => p.name === 'Dream Keys')!
  const userPresets = listUserPresets().filter(p => match(p.name))
  const favPresets = INST_PRESETS.filter(p => isFavorite(`i:${p.name}`) && match(`${p.name} ${p.cat}`))

  return (
    <div className="browser">
      <div className="browser-search">
        <Icon name="search" size={13} />
        <input
          placeholder="Search sounds…"
          value={q}
          onChange={e => setQ(e.target.value)}
          data-info="Search every pack: presets, kits, loops and progressions"
        />
      </div>
      <div className="browser-scroll">
        {userPresets.length > 0 && (
          <Section title="My Sounds">
            {userPresets.map(p => (
              <div key={p.name} className="bitem" draggable
                onDragStart={e => e.dataTransfer.setData('stg/preset', p.name)}
                onClick={() => engine.audition(p.type, p.params)}
                onDoubleClick={() => applyPreset({ name: p.name, cat: 'User', type: p.type, params: p.params })}
                data-info="Your saved preset · double-click to load · ✕ to delete">
                <span className="bitem-icon"><Icon name={instSchema(p.type).icon} size={12} /></span>{p.name}
                <button className="bitem-star" title="Delete" onClick={e => { e.stopPropagation(); removeUserPreset(p.name) }}><Icon name="close" size={11} /></button>
              </div>
            ))}
          </Section>
        )}
        {favPresets.length > 0 && (
          <Section title="Favorites">
            {favPresets.map(p => (
              <div key={p.name} className="bitem" draggable
                onDragStart={e => e.dataTransfer.setData('stg/preset', p.name)}
                onClick={() => engine.audition(p.type, p.params)}
                onDoubleClick={() => applyPreset(p)}
                data-info="Click: audition · Double-click: load">
                <span className="bitem-icon"><Icon name={instSchema(p.type).icon} size={12} /></span>{p.name}
                <Star id={`i:${p.name}`} />
              </div>
            ))}
          </Section>
        )}
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
                  <span className="bitem-icon"><Icon name={instSchema(p.type).icon} size={12} /></span>{p.name}
                  <Star id={`i:${p.name}`} />
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
              <span className="bitem-icon"><Icon name="drum" size={12} /></span>{k.name}
            </div>
          ))}
        </Section>

        <Section title="Chord Progressions">
          <div className="bcat">In your key: {NOTE_NAMES[rootPc]}</div>
          {progs.map(p => (
            <div
              key={p.name}
              className="bitem"
              draggable
              onDragStart={e => e.dataTransfer.setData('stg/prog', p.name)}
              onClick={() => engine.auditionPitches(auditionInst.type, auditionInst.params, p.chords.slice(0, 4).map(c => progressionPitches(rootPc, c)))}
              onDoubleClick={() => loadProgression(p)}
              data-info={`${p.numerals} (${p.mode}) — click: hear it in ${NOTE_NAMES[rootPc]} · double-click: drop into a slot · drag anywhere`}
            >
              <span className="bitem-icon"><Icon name={p.mode === 'major' ? 'sun' : 'moon'} size={12} /></span>{p.name}
              <span className="bitem-sub">{p.numerals}</span>
            </div>
          ))}
        </Section>

        <Section title="MIDI Loops">
          {loopCats.map(cat => {
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
                    data-info={l.forDrums
                      ? 'Double-click: drop into a free slot · Drag onto any clip slot or the timeline'
                      : `Loads transposed to your key (${NOTE_NAMES[rootPc]}) — double-click for a free slot, or drag anywhere`}
                  >
                    <span className="bitem-icon"><Icon name={LOOP_ICONS[cat] ?? 'note'} size={12} /></span>{l.name}
                  </div>
                ))}
              </div>
            )
          })}
        </Section>

        <Section title="Audio">
          <button className="bbtn" onClick={pickAudioFile} data-info="Import an audio file (mono or stereo) as an audio clip on a new track"><Icon name="sampler" size={13} />Import audio clip…</button>
          <div className="bcat" style={{ paddingBottom: 6 }}>Or drag an audio file onto the app</div>
        </Section>

        <Section title="Project">
          <button className="bbtn" onClick={loadDemo} data-info="Load the demo song (replaces the current project — undoable)"><Icon name="spark" size={13} />Load demo song</button>
          <button className="bbtn" onClick={newProject} data-info="Start fresh (undoable)"><Icon name="newdoc" size={13} />New project</button>
          <button className="bbtn" onClick={exportProjectFile} data-info="Download the project as a shareable .json file"><Icon name="save" size={13} />Save project file</button>
          <button className="bbtn" onClick={importProjectFile} data-info="Load a saved .synthtagram.json project"><Icon name="folder" size={13} />Import project</button>
        </Section>
      </div>
    </div>
  )
}

// Top bar: transport, tempo/swing/key, view switch, undo, export, share, presence.

import React, { useRef, useState, useSyncExternalStore } from 'react'
import { LAUNCH_Q_OPTIONS } from '../types'
import { meta, setBpm, setSwing, setTitle, setKeyScale, setLaunchQ } from '../state/doc'
import { undoMgr } from '../state/undo'
import { engine } from '../audio/engine'
import { setUI, ui, useUI } from '../state/store'
import { useY, useRaf } from './hooks'
import { NumberDrag, Knob, openMenu } from './widgets'
import { Icon } from './icons'
import { NOTE_NAMES, SCALES } from '../theory'
import { exportWav, exportProjectFile } from '../audio/render'
import { importProjectFile } from './actions'
import { captureToClip, setKbdEnabled, isKbdEnabled } from '../audio/input'
import { peersList, subscribeAwareness, awarenessVersion } from '../state/net'
import { ticksToBBS } from '../types'

const SWING_SPEC = { key: 'swing', label: 'Swing', min: 0, max: 0.6, def: 0, fmt: (v: number) => `${Math.round(v * 100)}%` }

function PlayButton() {
  const ref = useRef<HTMLButtonElement>(null)
  useRaf(() => {
    if (ref.current) ref.current.classList.toggle('playing', engine.playing)
  })
  return (
    <button ref={ref} className="transport-btn play" data-info="Play / Stop (Space)" onClick={() => engine.togglePlay()}>
      <span className="ico-play"><Icon name="play" /></span>
      <span className="ico-stop"><Icon name="stop" /></span>
    </button>
  )
}

function Position() {
  const ref = useRef<HTMLSpanElement>(null)
  useRaf(() => {
    if (ref.current) ref.current.textContent = ticksToBBS(Math.round(engine.playing ? engine.positionTicks() : engine.arrSeekTicks))
  })
  return <span ref={ref} className="position">1.1.1</span>
}

function Avatars() {
  useSyncExternalStore(subscribeAwareness, awarenessVersion)
  const peers = peersList()
  return (
    <div className="avatars" data-info="Who's in this jam — share the link to invite friends" onClick={() => setUI({ shareOpen: true })}>
      {peers.slice(0, 6).map(p => (
        <span key={p.id} className="avatar" style={{ background: p.state.color }} title={p.state.name + (p.me ? ' (you)' : '')}>
          {(p.state.name || '?').slice(0, 1).toUpperCase()}
        </span>
      ))}
      {peers.length > 6 && <span className="avatar more">+{peers.length - 6}</span>}
    </div>
  )
}

export function Topbar() {
  useY(meta)
  const view = useUI(s => s.view)
  const recording = useUI(s => s.recording)
  const metronome = useUI(s => s.metronome)
  const theme = useUI(s => s.theme)
  const chatUnread = useUI(s => s.chatUnread)
  const taps = useRef<number[]>([])
  const [kbdOn, setKbdOn] = useState(isKbdEnabled())

  const tap = () => {
    const now = performance.now()
    taps.current = taps.current.filter(t => now - t < 3000)
    taps.current.push(now)
    if (taps.current.length >= 3) {
      const iv = taps.current.slice(1).map((t, i) => t - taps.current[i])
      const avg = iv.reduce((a, b) => a + b, 0) / iv.length
      setBpm(Math.min(240, Math.max(40, 60000 / avg)))
    }
  }

  const exportMenu = (e: React.MouseEvent) => {
    const sceneId = ui.selClip?.kind === 'session' ? ui.selClip.sceneId : null
    openMenu(e, [
      { label: <><Icon name="download" /> Export WAV — arrangement</>, fn: () => exportWav({ kind: 'arr' }) },
      { label: <><Icon name="loop" /> Export WAV — loop region</>, fn: () => exportWav({ kind: 'loop' }) },
      { label: <><Icon name="play" /> Export WAV — selected scene (2 loops)</>, fn: () => sceneId ? exportWav({ kind: 'scene', sceneId }) : void 0, disabled: !sceneId },
      { label: <><Icon name="chord" /> Export stems — one WAV per track</>, fn: () => exportWav({ kind: 'arr' }, true) },
      'sep',
      { label: <><Icon name="save" /> Save project file</>, fn: exportProjectFile },
      { label: <><Icon name="folder" /> Import project file</>, fn: importProjectFile },
    ])
  }

  return (
    <div className="topbar">
      <div className="brand" data-info="Synthtagram — make a song together"><Icon name="logo" size={18} /><b>Synthtagram</b></div>
      <input
        className="title-input"
        value={meta.get('title') ?? ''}
        onChange={e => setTitle(e.target.value)}
        data-info="Project title"
      />

      <div className="tgroup transport">
        <PlayButton />
        <button
          className={`transport-btn rec ${recording ? 'on' : ''}`}
          data-info="Record: notes you play go into the armed track's playing clip"
          onClick={() => setUI({ recording: !recording })}
        ><Icon name="rec" /></button>
        <button className="transport-btn" data-info="Capture the last 30s you played into a clip — even though you weren't recording"
          onClick={() => captureToClip()}><Icon name="capture" /></button>
        <button className={`transport-btn ${metronome ? 'on' : ''}`} data-info="Metronome (M)"
          onClick={() => setUI({ metronome: !metronome })}><Icon name="metro" /></button>
        <Position />
      </div>

      <div className="tgroup">
        <label className="tlabel" data-info="Tempo — drag the number or tap">BPM</label>
        <NumberDrag value={meta.get('bpm') ?? 120} min={40} max={240} step={1} onChange={setBpm} info="Tempo: drag vertically, double-click to type" />
        <button className="tbtn" onClick={tap} data-info="Tap tempo — tap 3+ times">TAP</button>
        <Knob spec={SWING_SPEC} value={meta.get('swing') ?? 0} onChange={setSwing} size={26} />
      </div>

      <div className="tgroup">
        <select className="tselect" value={meta.get('root') ?? 9} data-info="Project key root — drives scale highlighting & snap"
          onChange={e => setKeyScale(+e.target.value, meta.get('scale') ?? 'minor')}>
          {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
        </select>
        <select className="tselect" value={meta.get('scale') ?? 'minor'} data-info="Project scale"
          onChange={e => setKeyScale(meta.get('root') ?? 9, e.target.value)}>
          {SCALES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <select className="tselect" value={meta.get('launchQ') ?? 1} data-info="Launch quantize: clips wait for this boundary so nothing comes in off-beat"
          onChange={e => setLaunchQ(+e.target.value)}>
          {LAUNCH_Q_OPTIONS.map(o => <option key={o.bars} value={o.bars}>Q: {o.label}</option>)}
        </select>
      </div>

      <div className="tgroup view-tabs">
        <button className={`vtab ${view === 'session' ? 'on' : ''}`} data-info="Session view: launch clips & jam (Tab)"
          onClick={() => setUI({ view: 'session' })}>Session</button>
        <button className={`vtab ${view === 'arr' ? 'on' : ''}`} data-info="Arrangement view: the song timeline (Tab)"
          onClick={() => setUI({ view: 'arr' })}>Arrange</button>
      </div>

      <div className="spacer" />

      <div className="tgroup">
        <button className="icon-btn" data-info="Undo your last edit (Ctrl/Cmd+Z) — only undoes YOUR changes" onClick={() => undoMgr.undo()}><Icon name="undo" /></button>
        <button className="icon-btn" data-info="Redo (Ctrl/Cmd+Shift+Z)" onClick={() => undoMgr.redo()}><Icon name="redo" /></button>
        <button className="icon-btn" data-info="Undo history — see & rewind your edits" onClick={() => setUI({ historyOpen: !ui.historyOpen })}><Icon name="clock" /></button>
        <button className="icon-btn" data-info="Command palette (Ctrl/Cmd+K)" onClick={() => setUI({ paletteOpen: true })}>⌘K</button>
        <button className={`icon-btn ${kbdOn ? 'lit' : ''}`} data-info="Computer-keyboard piano on/off (A–K play notes, Z/X octave)"
          onClick={() => { setKbdEnabled(!isKbdEnabled()); setKbdOn(isKbdEnabled()) }}><Icon name="keys" /></button>
        <button className="icon-btn" data-info="Export audio & project" onClick={exportMenu}><Icon name="download" /></button>
        <button className="icon-btn" data-info="Toggle light/dark theme" onClick={() => setUI({ theme: theme === 'dark' ? 'light' : 'dark' })}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button className="icon-btn" data-info="Help & shortcuts (?)" onClick={() => setUI({ helpOpen: true })}>?</button>
      </div>

      <div className="tgroup">
        <button className="share-btn" data-info="Invite friends — everyone edits the same project live" onClick={() => setUI({ shareOpen: true })}>
          <Icon name="link" /> Share
        </button>
        <Avatars />
        <button className="icon-btn chat-toggle" data-info="Chat with your collaborators" onClick={() => setUI({ chatOpen: !ui.chatOpen, chatUnread: 0 })}>
          <Icon name="chat" />{chatUnread > 0 && <span className="badge">{chatUnread}</span>}
        </button>
      </div>
    </div>
  )
}

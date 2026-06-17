// Export dialog: pick format (WAV / MP3 + bitrate) and channels (stereo / mono),
// then bounce the arrangement / loop / scene, or per-track stems. Also hosts the
// live "Record Output" capture and project-file save/import.

import React, { useState } from 'react'
import { exportAudio, exportProjectFile, RenderScope } from '../audio/render'
import { startRecording, stopRecording, isRecording, recordingSeconds } from '../audio/recorder'
import { AudioFormat, Channels } from '../audio/encode'
import { importProjectFile } from './actions'
import { ui } from '../state/store'
import { useRaf } from './hooks'
import { Icon } from './icons'

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const [format, setFormat] = useState<AudioFormat>('wav')
  const [kbps, setKbps] = useState(256)
  const [channels, setChannels] = useState<Channels>('stereo')
  const [rec, setRec] = useState(isRecording())
  const [recT, setRecT] = useState(0)

  useRaf(() => { if (isRecording()) setRecT(recordingSeconds()) })

  const sceneId = ui.selClip?.kind === 'session' ? ui.selClip.sceneId : null
  const opts = () => ({ format, channels, kbps, stems: false })

  const run = (scope: RenderScope, stems = false) => { exportAudio(scope, { ...opts(), stems }); if (!stems) onClose() }

  const toggleRec = async () => {
    if (isRecording()) { setRec(false); await stopRecording(format, channels, kbps) }
    else { await startRecording(); setRec(true) }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal export-dialog" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title"><Icon name="download" size={15} /> Export</span>
          <button className="icon-btn" onClick={onClose} data-info="Close"><Icon name="close" size={13} /></button>
        </div>

        <div className="export-row">
          <span className="export-label">Format</span>
          <div className="seg">
            <button className={format === 'wav' ? 'on' : ''} onClick={() => setFormat('wav')}>WAV</button>
            <button className={format === 'mp3' ? 'on' : ''} onClick={() => setFormat('mp3')}>MP3</button>
          </div>
          {format === 'mp3' && (
            <div className="seg">
              {[64, 128, 256].map(k => <button key={k} className={kbps === k ? 'on' : ''} onClick={() => setKbps(k)}>{k}</button>)}
              <span className="export-unit">kbps</span>
            </div>
          )}
          {format === 'wav' && <span className="export-unit">16-bit · lossless</span>}
        </div>

        <div className="export-row">
          <span className="export-label">Channels</span>
          <div className="seg">
            <button className={channels === 'stereo' ? 'on' : ''} onClick={() => setChannels('stereo')}>Stereo</button>
            <button className={channels === 'mono' ? 'on' : ''} onClick={() => setChannels('mono')}>Mono</button>
          </div>
        </div>

        <div className="export-actions">
          <button className="export-btn" onClick={() => run({ kind: 'arr' })}><Icon name="download" size={13} /> Arrangement</button>
          <button className="export-btn" onClick={() => run({ kind: 'loop' })}><Icon name="loop" size={13} /> Loop region</button>
          <button className="export-btn" disabled={!sceneId} onClick={() => sceneId && run({ kind: 'scene', sceneId })}><Icon name="play" size={13} /> Selected scene</button>
          <button className="export-btn" onClick={() => run({ kind: 'arr' }, true)}><Icon name="chord" size={13} /> Stems (per track)</button>
        </div>

        <div className="export-divider" />

        <div className="export-row record-row">
          <button className={`export-btn record ${rec ? 'on' : ''}`} onClick={toggleRec}>
            <span className="rec-dot" /> {rec ? `Stop — ${recT.toFixed(1)}s` : 'Record Output'}
          </button>
          <span className="export-hint">Captures exactly what you hear, live — including knob tweaks &amp; Auto-Tune.</span>
        </div>

        <div className="export-divider" />

        <div className="export-actions">
          <button className="export-btn ghost" onClick={() => { exportProjectFile(); onClose() }}><Icon name="save" size={13} /> Save project file</button>
          <button className="export-btn ghost" onClick={() => { importProjectFile(); onClose() }}><Icon name="folder" size={13} /> Import project file</button>
        </div>
      </div>
    </div>
  )
}

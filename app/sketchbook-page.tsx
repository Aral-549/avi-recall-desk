'use client'

import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Film,
  Image as ImageIcon,
  Mic,
  PenTool,
  Plus,
  Search,
  SlidersHorizontal,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import { hasSuggestions, liveItems, useAvi } from '@/lib/avi/store'
import { TAXONOMY, tagLabel } from '@/lib/avi/taxonomy'
import { REJECTABLE_FIELDS, type FieldName, type Item } from '@/lib/avi/types'
import { buildExport, download, toJSON } from '@/lib/avi/export'
import { getDataStore } from '@/lib/avi/datastore'

type View = 'desk' | 'review' | 'library' | 'ask'
type CaptureKind = 'text' | 'image' | 'video' | 'audio' | 'file' | 'sketch'
type ChatTurn = { id: string; role: 'user' | 'assistant'; text: string; citedItemIds?: string[] }

const ALL_PAGE = 'all'
const UNFILED_PAGE = 'unfiled'
const REVIEW_FIELDS: FieldName[] = ['oneLineSummary', 'tags', 'collection']

function titleFor(item: Item): string {
  if (item.title?.trim()) return item.title
  if (item.url) {
    try { return new URL(item.url).hostname.replace(/^www\./, '') } catch { return 'Untitled link' }
  }
  return item.attachment?.name ?? 'Untitled note'
}

function typeFor(item: Item): string {
  return item.fields.type?.value ?? (item.url ? 'link' : item.attachment ? 'file' : 'note')
}

function sourceFor(item: Item): string {
  return item.fields.source?.value ?? (item.url ? 'web' : item.attachment ? 'upload' : 'manual')
}

function summaryFor(item: Item): string {
  return item.fields.oneLineSummary?.value?.trim() || item.rawContent || item.whyISavedThis || 'A saved study from your archive.'
}

function dateLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'saved recently'
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000))
  if (days === 0) return 'saved today'
  if (days === 1) return 'saved yesterday'
  return `saved ${days} days ago`
}

function hash32(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function seeded(seed: string) {
  let state = hash32(seed)
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let result = Math.imul(state ^ (state >>> 15), 1 | state)
    result = (result + Math.imul(result ^ (result >>> 7), 61 | result)) ^ result
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296
  }
}

function wobblyRect(seed: string, width: number, height: number): [string, string] {
  const random = seeded(seed)
  const jitter = () => (random() * 2 - 1) * 1.4
  const pass = () => {
    const x1 = 3 + jitter(), y1 = 3 + jitter()
    const x2 = width - 3 + jitter(), y2 = 3 + jitter()
    const x3 = width - 3 + jitter(), y3 = height - 3 + jitter()
    const x4 = 3 + jitter(), y4 = height - 3 + jitter()
    const mx1 = (x1 + x2) / 2 + jitter() * .8, my1 = (y1 + y2) / 2 + jitter() * .8
    const mx2 = (x2 + x3) / 2 + jitter() * .8, my2 = (y2 + y3) / 2 + jitter() * .8
    const mx3 = (x3 + x4) / 2 + jitter() * .8, my3 = (y3 + y4) / 2 + jitter() * .8
    const mx4 = (x4 + x1) / 2 + jitter() * .8, my4 = (y4 + y1) / 2 + jitter() * .8
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${mx1.toFixed(1)} ${my1.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)} Q ${mx2.toFixed(1)} ${my2.toFixed(1)} ${x3.toFixed(1)} ${y3.toFixed(1)} Q ${mx3.toFixed(1)} ${my3.toFixed(1)} ${x4.toFixed(1)} ${y4.toFixed(1)} Q ${mx4.toFixed(1)} ${my4.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)} Z`
  }
  return [pass(), pass()]
}

function SketchFrame({ seedKey, width = 300, height = 220, dashed = false, tape = false, strokeWidth = 1.5 }: {
  seedKey: string; width?: number; height?: number; dashed?: boolean; tape?: boolean; strokeWidth?: number
}) {
  const [first, second] = useMemo(() => wobblyRect(seedKey, width, height), [seedKey, width, height])
  return <svg className="sketch-frame" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    {tape && <rect x={width / 2 - 34} y="-7" width="68" height="15" fill="url(#hatchPattern)" stroke="#2c2c2f" strokeWidth=".8" opacity=".7" />}
    <path d={first} fill="none" stroke="#2c2c2f" strokeWidth={strokeWidth} strokeDasharray={dashed ? '6 5' : undefined} vectorEffect="non-scaling-stroke" />
    <path d={second} fill="none" stroke="#2c2c2f" strokeWidth={strokeWidth * .7} opacity=".75" strokeDasharray={dashed ? '4 6' : undefined} vectorEffect="non-scaling-stroke" />
  </svg>
}

function LogoMark({ size = 42 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 48 48" className="logo-mark" aria-hidden="true">
    <g filter="url(#graphiteFilter)">
      <path d="M 4 4 Q 24 3 44 4 Q 45 24 44 44 Q 24 45 4 44 Q 3 24 4 4 Z" fill="none" stroke="#2c2c2f" strokeWidth="2" />
      <rect x="9" y="25" width="7" height="14" fill="url(#hatchPattern)" stroke="#2c2c2f" strokeWidth="1.4" />
      <rect x="20.5" y="17" width="7" height="22" fill="url(#hatchPattern)" stroke="#2c2c2f" strokeWidth="1.4" />
      <rect x="32" y="9" width="7" height="30" fill="#2c2c2f" stroke="#2c2c2f" strokeWidth="1.4" />
    </g>
  </svg>
}

function StudyIllustration({ title, kind }: { title: string; kind: string }) {
  const label = title.slice(0, 22)
  const presets = ['control', 'noor', 'multiverse', 'scrap', 'motion', 'label', 'twilight', 'erase', 'block']
  const preset = presets[hash32(title) % presets.length]
  return <svg viewBox="0 0 320 190" className="study-illustration" aria-hidden="true">
    <g filter="url(#graphiteFilter)">
      <line x1="14" y1="152" x2="306" y2="152" stroke="#87878c" strokeWidth=".9" strokeDasharray="4 4" />
      <line x1="28" y1="14" x2="28" y2="174" stroke="#87878c" strokeWidth=".9" strokeDasharray="4 4" />
      {preset === 'control' && <>
        <rect x="38" y="26" width="244" height="36" rx="18" fill="none" stroke="#87878c" strokeWidth="1.4" />
        <line x1="34" y1="22" x2="286" y2="66" stroke="#2c2c2f" strokeWidth="2.2" />
        <line x1="34" y1="66" x2="286" y2="22" stroke="#2c2c2f" strokeWidth="2.2" />
        <rect x="38" y="84" width="244" height="42" fill="url(#hatchPattern)" stroke="#2c2c2f" strokeWidth="1.7" />
        <text x="230" y="78" className="font-hand" fontSize="26" fill="#2c2c2f">r = 0</text>
      </>}
      {preset === 'noor' && <>
        <line x1="32" y1="48" x2="292" y2="48" stroke="#87878c" />
        <text x="34" y="122" className="font-sketch" fontSize="66" fontWeight="700" fill="#2c2c2f">{label.split(' ')[0]?.slice(0, 8) || 'Study'}</text>
        <circle cx="272" cy="46" r="15" fill="url(#hatchPattern)" stroke="#2c2c2f" strokeWidth="1.4" />
      </>}
      {preset === 'multiverse' && <>
        <rect x="26" y="22" width="116" height="120" fill="none" stroke="#2c2c2f" strokeWidth="1.6" />
        <rect x="154" y="22" width="140" height="54" fill="none" stroke="#2c2c2f" strokeWidth="1.6" />
        <rect x="154" y="86" width="140" height="56" fill="url(#hatchPattern)" stroke="#2c2c2f" strokeWidth="1.6" />
        <polygon points="72,62 72,102 108,82" fill="#2c2c2f" />
        <text x="166" y="58" className="font-sketch" fontSize="30" fontWeight="700" fill="#2c2c2f">{kind.toUpperCase()}</text>
      </>}
      {preset === 'scrap' && <>
        <g transform="rotate(-4 75 80)"><rect x="36" y="40" width="76" height="76" fill="none" stroke="#2c2c2f" strokeWidth="1.6" /><rect x="58" y="33" width="32" height="12" fill="url(#hatchPattern)" /><text x="60" y="92" className="font-sketch" fontSize="40" fontWeight="700" fill="#2c2c2f">A</text></g>
        <g transform="rotate(3 165 78)"><rect x="126" y="36" width="76" height="76" fill="none" stroke="#2c2c2f" strokeWidth="1.6" /><rect x="148" y="29" width="32" height="12" fill="url(#hatchPattern)" /><text x="150" y="88" className="font-sketch" fontSize="40" fontWeight="700" fill="#2c2c2f">V</text></g>
        <g transform="rotate(-2 250 82)"><rect x="216" y="42" width="72" height="76" fill="none" stroke="#2c2c2f" strokeWidth="1.6" /><rect x="236" y="35" width="32" height="12" fill="url(#hatchPattern)" /><text x="242" y="94" className="font-sketch" fontSize="40" fontWeight="700" fill="#2c2c2f">I</text></g>
      </>}
      {!['control', 'noor', 'multiverse', 'scrap'].includes(preset) && <>
        <circle cx="106" cy="82" r="46" fill="none" stroke="#2c2c2f" strokeWidth="1.6" />
        <rect x="136" y="44" width="136" height="78" fill="url(#hatchPattern)" stroke="#2c2c2f" strokeWidth="1.6" />
        <line x1="48" y1="136" x2="276" y2="30" stroke="#4b4b4f" strokeWidth="1.2" strokeDasharray="5 5" />
      </>}
      <text x="34" y="178" className="font-hand" fontSize="26" fill="#2c2c2f">{kind} study · {label.toLowerCase()}</text>
    </g>
  </svg>
}

function AttachmentPreview({ item, kind }: { item: Item; kind: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    let objectUrl = ''
    if (!item.attachment) return () => { alive = false }
    void getDataStore().getBlob(item.attachment.blobId).then((blob) => {
      if (!alive || !blob) return
      objectUrl = URL.createObjectURL(blob)
      setSrc(objectUrl)
    }).catch(() => undefined)
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [item.attachment])

  if (!item.attachment || !src) return <StudyIllustration title={titleFor(item)} kind={kind} />
  if (item.attachment.mime.startsWith('image/')) return <img className="attached-study-image" src={src} alt={titleFor(item)} />
  if (item.attachment.mime.startsWith('video/')) return <video className="attached-study-video" src={src} controls />
  if (item.attachment.mime.startsWith('audio/')) return <div className="attached-study-audio"><span className="font-type">audio note · {item.attachment.name}</span><audio src={src} controls /></div>
  return <div className="attached-study-file"><FileText size={30} /><span className="font-type">{item.attachment.name}</span></div>
}

function FieldText({ item, name, roomName }: { item: Item; name: FieldName; roomName?: string }) {
  const field = item.fields[name]
  if (!field) return <span>not set</span>
  if (name === 'tags') return <span>{Array.isArray(field.value) ? field.value.map((tag) => tagLabel(String(tag))).join(', ') || 'no tags' : String(field.value)}</span>
  if (name === 'collection') return <span>{roomName ?? 'unfiled'}</span>
  return <span>{String(field.value)}</span>
}

function PencilPad({ onSave }: { onSave: (file: File) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const isDrawing = useRef(false)
  const [strokes, setStrokes] = useState(0)

  function point(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return null
    const bounds = canvas.getBoundingClientRect()
    return { x: ((event.clientX - bounds.left) / bounds.width) * canvas.width, y: ((event.clientY - bounds.top) / bounds.height) * canvas.height }
  }

  function start(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    const at = point(event)
    if (!canvas || !context || !at) return
    isDrawing.current = true
    setStrokes((count) => count + 1)
    canvas.setPointerCapture(event.pointerId)
    context.beginPath()
    context.moveTo(at.x, at.y)
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (!isDrawing.current) return
    const context = canvasRef.current?.getContext('2d')
    const at = point(event)
    if (!context || !at) return
    context.strokeStyle = '#2c2c2f'
    context.lineWidth = 3
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.lineTo(at.x, at.y)
    context.stroke()
  }

  async function addSketch() {
    const canvas = canvasRef.current
    if (!canvas || strokes === 0) return
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (blob && blob.size > 120) onSave(new File([blob], `avi-study-${Date.now()}.png`, { type: 'image/png' }))
  }

  return <div className="pencil-pad">
    <div className="pad-heading"><span>live pencil pad</span><span>{strokes === 0 ? 'nothing drawn yet' : `${strokes} strokes`}</span></div>
    <canvas ref={canvasRef} width={900} height={280} aria-label="Draw a sketch to add to this study" onPointerDown={start} onPointerMove={move} onPointerUp={() => { isDrawing.current = false }} onPointerCancel={() => { isDrawing.current = false }} />
    <div className="pad-actions">
      <button className="touch-box" type="button" onClick={() => { const context = canvasRef.current?.getContext('2d'); context?.clearRect(0, 0, 900, 280); setStrokes(0) }}><SketchFrame seedKey="pad-clear" width={116} height={36} /><span>Turn page</span></button>
      <button className="touch-box" type="button" onClick={() => void addSketch()} disabled={strokes === 0}><SketchFrame seedKey="pad-add" width={132} height={36} /><span>Add sketch</span></button>
    </div>
  </div>
}

class SketchbookAudio {
  on = false
  context: AudioContext | null = null
  buffer: AudioBuffer | null = null
  master: GainNode | null = null

  init() {
    if (this.context || typeof window === 'undefined') return
    const Audio = window.AudioContext
    if (!Audio) return
    const context = (this.context = new Audio())
    const length = context.sampleRate * 2
    const buffer = context.createBuffer(1, length, context.sampleRate)
    const data = buffer.getChannelData(0)
    let filtered = 0
    for (let index = 0; index < length; index++) {
      const white = Math.random() * 2 - 1
      filtered = .6 * filtered + .4 * white
      data[index] = white * .7 + filtered * .3
    }
    this.buffer = buffer
    this.master = context.createGain()
    this.master.gain.value = .7
    this.master.connect(context.destination)
  }

  toggle(next: boolean) {
    if (next) {
      this.init()
      if (this.context?.state === 'suspended') void this.context.resume()
    }
    this.on = next && Boolean(this.context)
    if (this.on) {
      this.tap()
      window.setTimeout(() => this.rustle(), 110)
    }
    return this.on
  }

  tap() {
    if (!this.on || !this.context || !this.buffer || !this.master) return
    const time = this.context.currentTime
    const source = this.context.createBufferSource()
    source.buffer = this.buffer
    const filter = this.context.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 2400
    const gain = this.context.createGain()
    gain.gain.setValueAtTime(.24, time)
    gain.gain.exponentialRampToValueAtTime(.001, time + .035)
    source.connect(filter)
    filter.connect(gain)
    gain.connect(this.master)
    source.start(time, Math.random())
    source.stop(time + .05)
  }

  rustle() {
    if (!this.on || !this.context || !this.buffer || !this.master) return
    const time = this.context.currentTime
    const source = this.context.createBufferSource()
    source.buffer = this.buffer
    const filter = this.context.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 1250
    filter.Q.value = .5
    const gain = this.context.createGain()
    gain.gain.setValueAtTime(0, time)
    for (let index = 0; index < 5; index++) gain.gain.linearRampToValueAtTime(.16 * (.4 + Math.random() * .6), time + .04 + index * .08)
    gain.gain.linearRampToValueAtTime(0, time + .55)
    source.connect(filter)
    filter.connect(gain)
    gain.connect(this.master)
    source.start(time, Math.random())
    source.stop(time + .6)
  }
}

const audioEngine = new SketchbookAudio()

export default function SketchbookPage() {
  const hydrated = useAvi((state) => state.hydrated)
  const data = useAvi((state) => state.data)
  const page = useAvi((state) => state.page)
  const selectedId = useAvi((state) => state.selectedId)
  const toasts = useAvi((state) => state.toasts)
  const undoCount = useAvi((state) => state.undoStack.length)
  const storageIssue = useAvi((state) => state.storageIssue)
  const setPage = useAvi((state) => state.setPage)
  const select = useAvi((state) => state.select)
  const capture = useAvi((state) => state.capture)
  const createCollection = useAvi((state) => state.createCollection)
  const acceptField = useAvi((state) => state.acceptField)
  const rejectField = useAvi((state) => state.rejectField)
  const acceptItems = useAvi((state) => state.acceptItems)
  const deleteItems = useAvi((state) => state.deleteItems)
  const undo = useAvi((state) => state.undo)
  const dismissToast = useAvi((state) => state.dismissToast)

  const [view, setView] = useState<View>('desk')
  const [roomMenuOpen, setRoomMenuOpen] = useState(false)
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false)
  const [newRoomOpen, setNewRoomOpen] = useState(false)
  const [newRoomName, setNewRoomName] = useState('')
  const [captureKind, setCaptureKind] = useState<CaptureKind>('text')
  const [captureText, setCaptureText] = useState('')
  const [captureWhy, setCaptureWhy] = useState('')
  const [captureFiles, setCaptureFiles] = useState<File[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [showPad, setShowPad] = useState(false)
  const [soundOn, setSoundOn] = useState(false)
  const [expandedCard, setExpandedCard] = useState<string | null>(null)
  const [reviewId, setReviewId] = useState<string | null>(null)
  const [libraryQuery, setLibraryQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [askInput, setAskInput] = useState('')
  const [askTurns, setAskTurns] = useState<ChatTurn[]>([])
  const [notice, setNotice] = useState('')
  const uploadRef = useRef<HTMLInputElement>(null)

  useEffect(() => { void useAvi.getState().hydrate() }, [])

  const items = useMemo(() => liveItems(data).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [data])
  const rooms = data.collections
  const roomItems = useMemo(() => items.filter((item) => page === ALL_PAGE || (page === UNFILED_PAGE ? !item.fields.collection?.value : item.fields.collection?.value === page)), [items, page])
  const reviewItems = useMemo(() => items.filter(hasSuggestions), [items])
  const currentRoom = rooms.find((room) => room.id === page)
  const activeRoomLabel = page === ALL_PAGE ? 'all studies' : page === UNFILED_PAGE ? 'unfiled' : currentRoom?.name.toLowerCase() ?? 'room'
  const activeReview = reviewItems.find((item) => item.id === reviewId) ?? reviewItems[0]
  const selectedItem = items.find((item) => item.id === selectedId)
  const filteredItems = useMemo(() => items.filter((item) => {
    const haystack = `${titleFor(item)} ${item.url ?? ''} ${item.rawContent} ${item.whyISavedThis ?? ''} ${summaryFor(item)} ${(item.fields.tags?.value ?? []).join(' ')} ${typeFor(item)}`.toLowerCase()
    if (libraryQuery.trim() && !haystack.includes(libraryQuery.trim().toLowerCase())) return false
    if (typeFilter && typeFor(item) !== typeFilter) return false
    if (tagFilter && !(item.fields.tags?.value ?? []).some((tag) => String(tag) === tagFilter)) return false
    return true
  }), [items, libraryQuery, typeFilter, tagFilter])
  const roomSuggestions = roomItems.filter(hasSuggestions).length

  function showNotice(message: string) {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 3000)
  }

  function addFiles(files: FileList | File[]) {
    const next = Array.from(files)
    if (!next.length) return
    setCaptureFiles((current) => [...current, ...next])
  }

  async function handleCapture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!captureText.trim() && captureFiles.length === 0) return
    try {
      const ids = await capture({ text: captureText.trim(), files: captureFiles, why: captureWhy.trim() })
      if (!ids.length) return
      setCaptureText('')
      setCaptureWhy('')
      setCaptureFiles([])
      if (uploadRef.current) uploadRef.current.value = ''
      setShowPad(false)
      showNotice(ids.length === 1 ? 'Pinned to the sketchbook page' : `${ids.length} studies pinned to the page`)
    } catch {
      showNotice('The study could not be pinned. Your archive is unchanged.')
    }
  }

  function submitRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = createCollection(newRoomName)
    if (!id) return
    setPage(id)
    setNewRoomName('')
    setNewRoomOpen(false)
  }

  function itemRoomName(item: Item) {
    return rooms.find((room) => room.id === item.fields.collection?.value)?.name ?? 'Unfiled'
  }

  function provenance(item: Item, field: FieldName) {
    const value = item.fields[field]
    if (!value) return 'no provenance'
    const source = value.by === 'model' ? `AI${value.model ? ` · ${value.model}` : ''}` : value.by
    return `${source}${typeof value.confidence === 'number' ? ` · ${Math.round(value.confidence * 100)}%` : ''}`
  }

  function handleAskSubmit(value = askInput) {
    const query = value.trim()
    if (!query) return
    const words = query.toLowerCase().split(/[^a-z0-9-]+/).filter((word) => word.length > 2)
    const matches = items.map((item) => {
      const haystack = `${titleFor(item)} ${item.rawContent} ${item.whyISavedThis ?? ''} ${summaryFor(item)} ${(item.fields.tags?.value ?? []).join(' ')}`.toLowerCase()
      return { item, score: words.reduce((sum, word) => sum + Number(haystack.includes(word)), 0) }
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, 4)
    const reply = matches.length
      ? `Found ${matches.length} matching ${matches.length === 1 ? 'study' : 'studies'} by matching words in your saved titles, notes, summaries, and tags.`
      : `No exact keyword matches for “${query}”. There are ${reviewItems.length} studies waiting for your review.`
    setAskTurns((turns) => [...turns, { id: `q-${Date.now()}`, role: 'user', text: query }, { id: `a-${Date.now()}`, role: 'assistant', text: reply, citedItemIds: matches.map(({ item }) => item.id) }])
    setAskInput('')
  }

  function attachmentPicker(kind: CaptureKind) {
    setCaptureKind(kind)
    if (kind === 'sketch') {
      setShowPad(true)
      return
    }
    if (kind !== 'text') uploadRef.current?.click()
  }

  const attachmentAccept = 'image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.md,.zip,.csv,.json,application/pdf'

  async function exportArchive() {
    try {
      const doc = buildExport(data, { collection: 'all', includeSuggested: true })
      const json = await toJSON(doc, data, async (blobId) => (await getDataStore().getBlob(blobId)) ?? null)
      download('avi-sketchbook-export.json', json, 'application/json')
      showNotice('Archive JSON exported')
    } catch {
      showNotice('Could not export the archive')
    }
  }

  if (!hydrated) return <main className="sketch-loading"><LogoMark /><p>opening the AVI sketchbook</p></main>

  return <div className="sketchbook-app">
    <svg className="sketch-defs" aria-hidden="true">
      <defs>
        <filter id="graphiteFilter" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="1.15" numOctaves="2" seed="3" result="noise" /><feDisplacementMap in="SourceGraphic" in2="noise" scale="1.4" /></filter>
        <pattern id="hatchPattern" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-40)"><line x1="0" y1="0" x2="0" y2="7" stroke="#2c2c2f" strokeWidth="1.2" /></pattern>
      </defs>
    </svg>

    <header className="sketch-header">
      <div className="header-brand-room">
        <button className="brand-button" type="button" onClick={() => setView('desk')} aria-label="AVI sketchbook home"><LogoMark /><span className="brand-name">AVI<span>.</span></span><span className="brand-edition">sketchbook no. 7</span></button>
        <div className="dropdown-wrap">
          <button className="touch-box room-select" type="button" aria-expanded={roomMenuOpen} onClick={() => { setRoomMenuOpen((open) => !open); setToolsMenuOpen(false) }}><SketchFrame seedKey={`room-${page}`} width={250} height={48} /><span>room: {activeRoomLabel} ({roomItems.length})</span><ChevronDown size={15} /></button>
          {roomMenuOpen && <div className="sketch-menu room-menu" role="menu"><SketchFrame seedKey="room-menu-frame" width={300} height={320} /><div className="menu-content"><p className="font-type menu-label">select project room</p>
            <button role="menuitem" type="button" onClick={() => { setPage(ALL_PAGE); setRoomMenuOpen(false) }}>all studies <span className="font-type">{items.length}</span></button>
            {rooms.map((room) => <button role="menuitem" key={room.id} type="button" onClick={() => { setPage(room.id); setRoomMenuOpen(false) }}>{room.name.toLowerCase()} <span className="font-type">{items.filter((item) => item.fields.collection?.value === room.id).length}</span></button>)}
            <button role="menuitem" type="button" onClick={() => { setPage(UNFILED_PAGE); setRoomMenuOpen(false) }}>unfiled <span className="font-type">{items.filter((item) => !item.fields.collection?.value).length}</span></button>
            <button className="new-room-link" role="menuitem" type="button" onClick={() => { setNewRoomOpen(true); setRoomMenuOpen(false) }}>+ new room…</button>
          </div></div>}
        </div>
      </div>

      <nav className="sketch-nav" aria-label="Sections">
        {([['desk', 'studies & pad'], ['review', `triage (${reviewItems.length})`], ['library', 'index'], ['ask', 'ask avi']] as const).map(([id, label]) => <button key={id} type="button" className={`nav-sketch${view === id ? ' active' : ''}`} aria-current={view === id ? 'page' : undefined} onClick={() => { audioEngine.tap(); setView(id); if (id === 'review') setReviewId(reviewItems[0]?.id ?? null) }}>{label}</button>)}
        <div className="dropdown-wrap tools-wrap"><button className="touch-box tools-select" type="button" aria-expanded={toolsMenuOpen} onClick={() => { setToolsMenuOpen((open) => !open); setRoomMenuOpen(false) }}><SketchFrame seedKey="tools-menu-button" width={128} height={44} /><span>tools ▾</span></button>
          {toolsMenuOpen && <div className="sketch-menu tools-menu"><SketchFrame seedKey="tools-menu-frame" width={260} height={210} /><div className="menu-content">
            <button type="button" onClick={() => { setSoundOn(audioEngine.toggle(!soundOn)); setToolsMenuOpen(false) }}>pencil sound <span className="font-type">{soundOn ? 'on' : 'off'}</span></button>
            <button type="button" onClick={() => { setToolsMenuOpen(false); setNewRoomOpen(true) }}>new project room <Plus size={14} /></button>
            <button type="button" onClick={() => { setToolsMenuOpen(false); setView('review'); setReviewId(reviewItems[0]?.id ?? null) }}>bulk stamp / revert <SlidersHorizontal size={14} /></button>
            <button type="button" onClick={() => { setToolsMenuOpen(false); setView('library') }}>taxonomy &amp; tags <SlidersHorizontal size={14} /></button>
            <button type="button" onClick={() => { setToolsMenuOpen(false); void exportArchive() }}>export archive JSON <Download size={14} /></button>
            <button type="button" onClick={() => { setToolsMenuOpen(false); undo() }} disabled={!undoCount}>undo last stroke <Undo2 size={14} /></button>
          </div></div>}
        </div>
      </nav>
    </header>

    {storageIssue && <div className="storage-notice" role="status">{storageIssue.message}<button type="button" onClick={() => void exportArchive()}>export a copy</button></div>}

    <main className="sketch-main">
      {view === 'desk' && <>
        <section className="desk-hero">
          <div className="hero-copy">
            <p className="font-hand hero-kicker">page 1 · personal recall sketchbook</p>
            <div className="hero-wordmark" aria-label="AVI">
              <svg viewBox="0 0 540 225" role="img" aria-labelledby="avi-wordmark-title"><title id="avi-wordmark-title">AVI</title>
                <g opacity=".45"><line x1="0" y1="36" x2="520" y2="36" stroke="#6e6e73" strokeDasharray="6 6" /><line x1="0" y1="168" x2="520" y2="168" stroke="#6e6e73" /><circle cx="88" cy="108" r="68" fill="none" stroke="#6e6e73" /><rect x="372" y="36" width="96" height="132" fill="none" stroke="#6e6e73" strokeDasharray="4 4" /></g>
                <rect x="14" y="176" width="440" height="22" fill="url(#hatchPattern)" stroke="#2c2c2f" />
                <g filter="url(#graphiteFilter)"><text x="8" y="164" className="font-sketch" fontSize="188" fontWeight="700" fill="#2c2c2f" letterSpacing="-3">AVI.</text></g>
                <text x="380" y="28" className="font-hand" fontSize="24" fill="#424246">fig. 0 · r = 0</text>
              </svg>
            </div>
            <p className="font-hand hero-description">keep links, photos, videos, voice notes, pdfs, and pencil sketches in one place. models suggest tags &amp; summary; nothing is filed until you stamp it.</p>
            <div className="hero-actions">
              <button className="touch-box sound-toggle" type="button" aria-pressed={soundOn} onClick={() => setSoundOn(audioEngine.toggle(!soundOn))}><SketchFrame seedKey="hero-sound-btn" width={235} height={52} /><span>{soundOn ? <Volume2 size={19} /> : <VolumeX size={19} />}{soundOn ? 'Pencil sound is on' : 'Turn on pencil sound'}</span></button>
              {roomSuggestions > 0 && <button className="touch-box triage-cta" type="button" onClick={() => { setView('review'); setReviewId(reviewItems[0]?.id ?? null) }}><SketchFrame seedKey="hero-triage-btn" width={245} height={52} /><span>Triage {roomSuggestions} unconfirmed →</span></button>}
            </div>
          </div>

          <form className={`capture-pad${isDragging ? ' dragging' : ''}`} onSubmit={handleCapture} onDragOver={(event) => { event.preventDefault(); setIsDragging(true) }} onDragLeave={() => setIsDragging(false)} onDrop={(event) => { event.preventDefault(); setIsDragging(false); addFiles(event.dataTransfer.files) }} aria-label="Pin a new multi-modal study">
            <SketchFrame seedKey="capture-main-box" width={640} height={480} tape strokeWidth={1.8} />
            <div className="capture-pad-inner">
              <input ref={uploadRef} className="hidden-upload" type="file" multiple accept={attachmentAccept} onChange={(event) => { if (event.currentTarget.files) addFiles(event.currentTarget.files); event.currentTarget.value = '' }} aria-label="Choose study files" />
              <div className="capture-kind-row"><span className="font-type capture-prefix">pin:</span>
                <button className={`touch-box capture-kind${captureKind === 'text' ? ' selected' : ''}`} type="button" aria-pressed={captureKind === 'text'} onClick={() => setCaptureKind('text')}><SketchFrame seedKey="tab-text" width={125} height={42} /><span>Note / URL</span></button>
                <button className={`touch-box capture-kind${captureKind === 'image' ? ' selected' : ''}`} type="button" aria-pressed={captureKind === 'image'} onClick={() => attachmentPicker('image')}><SketchFrame seedKey="tab-image" width={102} height={42} /><ImageIcon size={15} /><span>Image</span></button>
                <button className={`touch-box capture-kind${captureKind === 'video' ? ' selected' : ''}`} type="button" aria-pressed={captureKind === 'video'} onClick={() => attachmentPicker('video')}><SketchFrame seedKey="tab-video" width={102} height={42} /><Film size={15} /><span>Video</span></button>
                <button className={`touch-box capture-kind${captureKind === 'audio' ? ' selected' : ''}`} type="button" aria-pressed={captureKind === 'audio'} onClick={() => attachmentPicker('audio')}><SketchFrame seedKey="tab-audio" width={102} height={42} /><Mic size={15} /><span>Audio</span></button>
                <button className={`touch-box capture-kind${captureKind === 'file' ? ' selected' : ''}`} type="button" aria-pressed={captureKind === 'file'} onClick={() => attachmentPicker('file')}><SketchFrame seedKey="tab-file" width={124} height={42} /><FileText size={15} /><span>PDF / File</span></button>
                <button className={`touch-box capture-kind${captureKind === 'sketch' ? ' selected' : ''}`} type="button" aria-pressed={captureKind === 'sketch'} onClick={() => attachmentPicker('sketch')}><SketchFrame seedKey="tab-sketch" width={130} height={42} /><PenTool size={15} /><span>Draw Sketch</span></button>
              </div>
              {captureFiles.length > 0 && <div className="staged-files"><div className="font-type">attached files · {captureFiles.length}</div>{captureFiles.map((file, index) => <div key={`${file.name}-${index}`} className="staged-file"><span>{file.name} ({Math.max(1, Math.round(file.size / 1024))} KB)</span><button type="button" onClick={() => setCaptureFiles((files) => files.filter((_, fileIndex) => fileIndex !== index))}>remove ×</button></div>)}</div>}
              {showPad && <PencilPad onSave={(file) => setCaptureFiles((files) => [...files, file])} />}
              <textarea className="capture-text font-hand" value={captureText} onChange={(event) => setCaptureText(event.target.value)} rows={2} placeholder={captureKind === 'image' ? 'Add a caption or image URL…' : captureKind === 'video' ? 'Paste a video URL or add study notes…' : 'Paste a link, or write a quick note…'} aria-label="Link or note content" />
              <div className="capture-bottom">
                <input className="capture-why font-hand" value={captureWhy} onChange={(event) => setCaptureWhy(event.target.value)} placeholder="margin note: why are you keeping this? (optional)…" aria-label="Why are you saving this?" />
                <button type="submit" className="touch-box pin-submit" disabled={!captureText.trim() && captureFiles.length === 0}><SketchFrame seedKey="submit-scrap-btn" width={180} height={48} strokeWidth={1.9} /><span>Pin to page →</span></button>
              </div>
            </div>
          </form>
        </section>

        <section className="studies-section" aria-labelledby="studies-heading">
          <div className="studies-heading"><div><span className="font-type section-number">01</span><h2 id="studies-heading" className="font-sketch underline-study">Studies</h2><span className="font-hand studies-count">({roomItems.length} in {activeRoomLabel})</span></div><span className="font-type studies-sort">{roomItems.some((item) => item.origin === 'seed') ? 'ILLUSTRATIVE SAMPLE DATA' : roomItems.length ? 'RECENT STUDIES' : 'EMPTY PAGE'}</span></div>
          {roomItems.length ? <div className="studies-grid">{roomItems.map((item, index) => <StudyCard key={item.id} item={item} index={index} roomName={itemRoomName(item)} expanded={expandedCard === item.id} onExpand={() => setExpandedCard((open) => open === item.id ? null : item.id)} onInspect={() => { select(item.id); setView('library') }} onDelete={() => deleteItems([item.id])} onAccept={(name) => acceptField(item.id, name)} onReject={(name) => rejectField(item.id, name)} onStamp={() => acceptItems([item.id])} />)}</div> : <div className="empty-study"><SketchFrame seedKey="empty-study" width={480} height={140} /><h3 className="font-sketch">A fresh page.</h3><p className="font-hand">Pin your first study above. The archive keeps it with the reason you saved it.</p></div>}
        </section>
      </>}

      {view === 'review' && <section className="review-page">
        <div className="review-title"><span className="font-type section-number">02</span><h1 className="font-sketch">Erase and correct</h1><p className="font-hand">models suggest, you confirm. step through {reviewItems.length} unconfirmed studies.</p></div>
        {activeReview ? <article className="review-study study-card"><SketchFrame seedKey={`review-${activeReview.id}`} width={640} height={620} tape strokeWidth={1.7} />
          <div className="review-study-top"><span className="font-type">study {reviewItems.findIndex((item) => item.id === activeReview.id) + 1} of {reviewItems.length} · {typeFor(activeReview)}</span><span className="font-type">{sourceFor(activeReview)}</span></div>
          <div className="review-art"><AttachmentPreview item={activeReview} kind={typeFor(activeReview)} /></div>
          <h2 className="font-sketch">{titleFor(activeReview)}</h2><p className="font-hand review-summary">{summaryFor(activeReview)}</p>
          {activeReview.whyISavedThis && <p className="font-hand saved-note">“{activeReview.whyISavedThis}”</p>}
          <div className="review-fields">{REVIEW_FIELDS.map((name) => {
            const field = activeReview.fields[name]
            if (!field) return null
            const suggested = field.state === 'suggested'
            return <div className="review-field" key={name}><div><span className="font-type">{name === 'oneLineSummary' ? 'SUMMARY' : name.toUpperCase()} · {provenance(activeReview, name)}</span><strong className="font-hand"><FieldText item={activeReview} name={name} roomName={itemRoomName(activeReview)} /></strong></div>
              {suggested && <div className="field-actions"><button type="button" className="touch-box field-keep" onClick={() => acceptField(activeReview.id, name)}><SketchFrame seedKey={`keep-${name}`} width={88} height={36} /><span>keep ✓</span></button>{REJECTABLE_FIELDS.includes(name) && <button type="button" className="touch-box field-erase" onClick={() => rejectField(activeReview.id, name)}><SketchFrame seedKey={`erase-${name}`} width={78} height={36} dashed /><span>erase ×</span></button>}</div>}
            </div>
          })}</div>
          <div className="review-controls"><button type="button" className="touch-box" onClick={() => { const index = reviewItems.findIndex((item) => item.id === activeReview.id); setReviewId(reviewItems[(index - 1 + reviewItems.length) % reviewItems.length]?.id ?? null) }} aria-label="Previous study"><SketchFrame seedKey="prev-study" width={86} height={38} /><span><ChevronLeft size={15} /> previous</span></button><button type="button" className="touch-box" onClick={() => { const index = reviewItems.findIndex((item) => item.id === activeReview.id); setReviewId(reviewItems[(index + 1) % reviewItems.length]?.id ?? null) }} aria-label="Next study"><SketchFrame seedKey="next-study" width={86} height={38} /><span>next <ChevronRight size={15} /></span></button></div>
          <button type="button" className="touch-box stamp-all" onClick={() => acceptItems([activeReview.id])}><SketchFrame seedKey="stamp-all" width={220} height={48} strokeWidth={1.8} /><span>Stamp all suggestions ✓</span></button>
        </article> : <div className="empty-study"><SketchFrame seedKey="empty-review" width={480} height={150} /><h2 className="font-sketch">Nothing to erase.</h2><p className="font-hand">New model suggestions will appear here, ready for your pencil.</p><button type="button" className="touch-box" onClick={() => setView('desk')}><SketchFrame seedKey="back-desk" width={150} height={40} /><span>back to studies</span></button></div>}
      </section>}

      {view === 'library' && <section className="index-page">
        <div className="index-controls"><label className="index-search"><SketchFrame seedKey="index-search" width={480} height={52} /><Search size={18} /><input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="search studies by title, note, tag, or media type…" aria-label="Search studies" /></label>
          <label className="filter-label"><span className="sr-only">Filter by media type</span><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">all media types</option>{[...new Set(items.map(typeFor))].sort().map((type) => <option key={type}>{type}</option>)}</select></label>
          <label className="filter-label"><span className="sr-only">Filter by tag</span><select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">all tags</option>{TAXONOMY.map((tag) => <option value={tag.id} key={tag.id}>{tag.label}</option>)}</select></label>
          {(libraryQuery || typeFilter || tagFilter) && <button className="touch-box clear-index" type="button" onClick={() => { setLibraryQuery(''); setTypeFilter(''); setTagFilter('') }}>clear filters</button>}
        </div>
        <div className="index-layout"><div className="index-list study-card"><SketchFrame seedKey="index-list" width={700} height={650} />
          <div className="index-list-content">{filteredItems.map((item, index) => <button key={item.id} className={`index-row${selectedId === item.id ? ' selected' : ''}`} type="button" onClick={() => select(item.id)}><div><span className="font-type index-row-meta">fig. {index + 1} [{typeFor(item)}]</span><strong className="font-sketch">{titleFor(item)}</strong><span className="font-hand">{summaryFor(item)}</span></div><ChevronRight size={18} /></button>)}
            {!filteredItems.length && <div className="index-empty font-hand">No studies match that phrase. Try another word or clear the filters.</div>}</div>
        </div>
        <aside className="index-detail study-card">{selectedItem && filteredItems.some((item) => item.id === selectedItem.id) ? <><SketchFrame seedKey={`index-detail-${selectedItem.id}`} width={380} height={520} tape />
            <div className="detail-content"><span className="font-type">{typeFor(selectedItem)} · {sourceFor(selectedItem)} · {dateLabel(selectedItem.createdAt)}</span><h2 className="font-sketch">{titleFor(selectedItem)}</h2><p className="font-hand">{summaryFor(selectedItem)}</p>{selectedItem.whyISavedThis && <blockquote className="font-hand">“{selectedItem.whyISavedThis}”</blockquote>}
              <div className="detail-data"><span className="font-type">ROOM</span><strong className="font-hand">{itemRoomName(selectedItem)}</strong><span className="font-type">TAGS</span><strong className="font-hand">{(selectedItem.fields.tags?.value ?? []).map((tag) => tagLabel(String(tag))).join(', ') || 'none yet'}</strong></div>
              {selectedItem.url && <a href={selectedItem.url} target="_blank" rel="noreferrer" className="hand-link font-hand">open original <ExternalLink size={14} /></a>}
              <div className="detail-actions">{hasSuggestions(selectedItem) && <button type="button" className="touch-box" onClick={() => acceptItems([selectedItem.id])}><SketchFrame seedKey="index-stamp" width={132} height={40} /><span>stamp study</span></button>}<button type="button" className="hand-link font-hand" onClick={() => deleteItems([selectedItem.id])}>tear out ×</button></div>
            </div></> : <div className="detail-empty font-hand"><SketchFrame seedKey="index-detail-empty" width={380} height={200} /><span>choose a study to see its notes.</span></div>}</aside></div>
      </section>}

      {view === 'ask' && <section className="ask-page study-card"><SketchFrame seedKey="ask-avi-box" width={700} height={620} tape />
        <div className="ask-content"><span className="font-type section-number">04</span><h1 className="font-sketch">Talk to the AVI sketchbook</h1><p className="font-type ask-honesty">LOCAL KEYWORD MATCHES · ANSWERS QUOTE YOUR SAVED STUDIES</p>
          {!askTurns.length && <div className="ask-prompts">{['What did I save about focus indicators?', 'Show studies on shadows and typography', 'What video studies are in my archive?'].map((prompt) => <button key={prompt} className="touch-box" type="button" onClick={() => handleAskSubmit(prompt)}><SketchFrame seedKey={prompt} width={350} height={44} /><span>{prompt}</span><ArrowRight size={14} /></button>)}</div>}
          <div className="ask-turns" aria-live="polite">{askTurns.map((turn) => <div className={`ask-turn ${turn.role}`} key={turn.id}><span className="font-type">{turn.role === 'user' ? 'you' : 'avi sketchbook · keyword matches'}</span><p className="font-hand">{turn.text}</p>{turn.citedItemIds?.map((id) => { const item = items.find((entry) => entry.id === id); return item ? <button type="button" className="ask-citation font-hand" key={id} onClick={() => { select(id); setView('library') }}>{titleFor(item)} →</button> : null })}</div>)}</div>
          <form className="ask-form" onSubmit={(event) => { event.preventDefault(); handleAskSubmit() }}><input className="font-hand" value={askInput} onChange={(event) => setAskInput(event.target.value)} placeholder="ask about your saved studies…" aria-label="Ask AVI about saved studies" /><button className="touch-box" type="submit"><SketchFrame seedKey="ask-send" width={108} height={44} /><span>ask →</span></button></form>
        </div>
      </section>}
    </main>

    <footer className="sketch-footer"><div><div className="footer-brand"><LogoMark size={40} /><span className="font-sketch">AVI.</span></div><p className="font-hand">square hand-drawn touch boxes, graphite paper grain, and multimodal studies.</p></div><button className="touch-box footer-undo" type="button" onClick={undo} disabled={!undoCount}><SketchFrame seedKey="footer-undo" width={160} height={44} /><span>undo ({undoCount})</span></button></footer>
    <div className="sketch-toasts" aria-live="polite">{toasts.map((toast) => <div className="sketch-toast" role="status" key={toast.id}><SketchFrame seedKey={`toast-${toast.id}`} width={350} height={56} /><span className="font-hand">{toast.message}</span>{toast.action && <button type="button" onClick={toast.action.run}>undo</button>}<button type="button" onClick={() => dismissToast(toast.id)} aria-label="Dismiss notification"><X size={14} /></button></div>)}{notice && <div className="sketch-toast" role="status"><SketchFrame seedKey="save-toast" width={350} height={56} /><span className="font-hand">{notice}</span><Check size={15} /></div>}</div>

    {newRoomOpen && <div className="sketch-modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewRoomOpen(false) }}><section className="new-room-dialog study-card" role="dialog" aria-modal="true" aria-labelledby="new-room-title"><SketchFrame seedKey="new-room-frame" width={460} height={260} tape /><div className="dialog-inner"><div className="dialog-top font-type"><span>new sketchbook room</span><button type="button" onClick={() => setNewRoomOpen(false)} aria-label="Close"><X size={16} /></button></div><h2 id="new-room-title" className="font-sketch">Start a new page.</h2><form onSubmit={submitRoom}><input className="font-hand" value={newRoomName} onChange={(event) => setNewRoomName(event.target.value)} maxLength={50} placeholder="name this room…" aria-label="Room name" /><button className="touch-box" type="submit" disabled={!newRoomName.trim()}><SketchFrame seedKey="create-room" width={130} height={42} /><span>make room</span></button></form></div></section></div>}
  </div>
}

function StudyCard({ item, index, roomName, expanded, onExpand, onInspect, onDelete, onAccept, onReject, onStamp }: {
  item: Item; index: number; roomName: string; expanded: boolean; onExpand: () => void; onInspect: () => void; onDelete: () => void;
  onAccept: (name: FieldName) => void; onReject: (name: FieldName) => void; onStamp: () => void
}) {
  const rotation = ((hash32(item.id) % 5) - 2) * .4
  const tags = item.fields.tags?.value ?? []
  return <article className="study-card study-tile" style={{ transform: `rotate(${rotation}deg)` }}>
    <SketchFrame seedKey={`study-card-${item.id}`} width={360} height={590} tape />
    <div className="tile-top font-type"><span>fig. {index + 1} · {typeFor(item)}</span>{hasSuggestions(item) ? <button className="touch-box mini-stamp" type="button" onClick={onStamp}><SketchFrame seedKey={`stamp-${item.id}`} width={96} height={36} /><span>stamp ✓</span></button> : <span className="filed-stamp">{item.status === 'ready' ? 'FILED' : item.status.toUpperCase()}</span>}</div>
    <div className="tile-visual"><AttachmentPreview item={item} kind={typeFor(item)} /></div>
    <h3 className="font-sketch">{titleFor(item)}</h3><p className="font-hand tile-summary">{summaryFor(item)}</p>
    {item.whyISavedThis && <p className="font-hand tile-why">“{item.whyISavedThis}”</p>}
    <div className="tile-tags">{tags.slice(0, 3).map((tag) => <span className="font-type" key={String(tag)}>#{tagLabel(String(tag))}</span>)}</div>
    <div className="tile-bottom">{item.url ? <a className="font-hand" href={item.url} target="_blank" rel="noreferrer">open it →</a> : <span className="font-type">{dateLabel(item.createdAt)}</span>}<button type="button" className="font-hand fields-toggle" aria-expanded={expanded} onClick={onExpand}>{expanded ? 'hide fields ▲' : 'fields ▼'}</button></div>
    {expanded && <div className="tile-fields">{(['oneLineSummary', 'tags', 'collection', 'type', 'source'] as FieldName[]).map((name) => {
      const field = item.fields[name]
      if (!field) return null
      return <div className="tile-field" key={name}><div><span className="font-type">{name === 'oneLineSummary' ? 'SUMMARY' : name.toUpperCase()} · {field.by === 'model' ? `AI ${field.model ?? ''}` : field.by}{typeof field.confidence === 'number' ? ` · ${Math.round(field.confidence * 100)}%` : ''}</span><strong className="font-hand">{name === 'tags' ? (field.value as string[]).map((tag) => tagLabel(String(tag))).join(', ') : name === 'collection' ? roomName : String(field.value)}</strong></div>
        {field.state === 'suggested' && <span className="field-actions"><button type="button" onClick={() => onAccept(name)}>keep</button>{REJECTABLE_FIELDS.includes(name) && <button type="button" onClick={() => onReject(name)}>erase</button>}</span>}</div>
    })}<div className="tile-field-links"><button type="button" onClick={onInspect}>inspect in index →</button><button type="button" onClick={onDelete}>tear out ×</button></div></div>}
  </article>
}

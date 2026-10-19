'use client'

import {
  ArrowDownRight,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Command,
  Copy,
  ExternalLink,
  FileText,
  FolderOpen,
  Keyboard,
  Link2,
  Plus,
  Search,
  Sparkles,
  Upload,
  PenTool,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { hasSuggestions, itemsOnPage, liveItems, useAvi } from '@/lib/avi/store'
import { tagLabel, TAXONOMY } from '@/lib/avi/taxonomy'
import { REJECTABLE_FIELDS, type FieldName, type Item, type ItemFields } from '@/lib/avi/types'

type View = 'room' | 'review' | 'library' | 'ask'

const ALL_PAGE = 'all'
const REVIEW_FIELDS: FieldName[] = ['tags', 'oneLineSummary', 'collection']

function titleFor(item: Item): string {
  if (item.title?.trim()) return item.title
  if (item.url) {
    try {
      const url = new URL(item.url)
      return url.hostname.replace(/^www\./, '')
    } catch {
      return 'Untitled link'
    }
  }
  return item.attachment?.name ?? 'Untitled note'
}

function domainFor(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '')
  } catch {
    return value
  }
}

function summaryFor(item: Item): string {
  const summary = item.fields.oneLineSummary?.value
  return summary?.trim() || item.rawContent || item.whyISavedThis || 'A saved item from this room.'
}

function sourceFor(item: Item): string {
  return item.fields.source?.value ?? (item.url ? 'web' : item.attachment ? 'upload' : 'manual')
}

function typeFor(item: Item): string {
  return item.fields.type?.value ?? (item.url ? 'link' : item.attachment ? 'file' : 'note')
}

function relativeDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Saved recently'
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000))
  if (days === 0) return 'Saved today'
  if (days === 1) return 'Saved yesterday'
  if (days < 30) return `Saved ${days} days ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `Saved ${months} ${months === 1 ? 'month' : 'months'} ago`
  return `Saved ${Math.floor(months / 12)} ${Math.floor(months / 12) === 1 ? 'year' : 'years'} ago`
}

function fieldValue(item: Item, name: FieldName): unknown {
  return item.fields[name]?.value
}

function valueLabel(item: Item, name: FieldName, collections: { id: string; name: string }[]): string {
  const value = fieldValue(item, name)
  if (name === 'tags') return Array.isArray(value) && value.length ? value.map((tag) => tagLabel(String(tag))).join(', ') : 'No tags'
  if (name === 'collection') return collections.find((collection) => collection.id === value)?.name ?? 'Unfiled'
  if (typeof value === 'string' && value) return name === 'source' || name === 'type' ? value.replaceAll('-', ' ') : value
  return 'Not set'
}

function provenanceLabel(item: Item, name: FieldName): string {
  const field = item.fields[name]
  if (!field) return 'No suggestion'
  const origin = field.by === 'model' ? `AI${field.model ? ` · ${field.model}` : ''}` : field.by
  const confidence = typeof field.confidence === 'number' ? ` · ${Math.round(field.confidence * 100)}% confidence` : ''
  return `${origin}${confidence}`
}

function typeMark(type: string) {
  if (type === 'github') return 'GH'
  if (type === 'video') return 'VID'
  if (type === 'image') return 'IMG'
  if (type === 'pdf') return 'PDF'
  if (type === 'note') return 'NOTE'
  return 'LINK'
}

function ItemRow({ item, selected, collections, onSelect }: {
  item: Item
  selected?: boolean
  collections: { id: string; name: string }[]
  onSelect: () => void
}) {
  const tags = item.fields.tags?.value ?? []
  return (
    <button className={`item-row${selected ? ' is-selected' : ''}`} type="button" onClick={onSelect} aria-pressed={selected}>
      <span className="item-mark" aria-hidden="true">{typeMark(typeFor(item))}</span>
      <span className="item-row-copy">
        <span className="item-row-heading">
          <strong>{titleFor(item)}</strong>
          {hasSuggestions(item) && <span className="mini-suggestion">Needs review</span>}
        </span>
        <span className="item-row-summary">{summaryFor(item)}</span>
        <span className="item-row-meta">
          <span>{sourceFor(item)}</span>
          <span className="meta-dot" aria-hidden="true" />
          <span>{collections.find((collection) => collection.id === item.fields.collection?.value)?.name ?? 'Unfiled'}</span>
          {tags.length > 0 && <><span className="meta-dot" aria-hidden="true" /><span>{tagLabel(tags[0])}</span></>}
        </span>
      </span>
      <ChevronRight className="row-chevron" size={16} aria-hidden="true" />
    </button>
  )
}

function FieldValue({ item, name, collections }: { item: Item; name: FieldName; collections: { id: string; name: string }[] }) {
  const value = fieldValue(item, name)
  if (name === 'tags' && Array.isArray(value)) {
    return <span className="tag-list">{value.length ? value.map((tag) => <span className="tag-chip" key={String(tag)}>{tagLabel(String(tag))}</span>) : <span className="muted-value">No tags yet</span>}</span>
  }
  return <span className="field-value">{valueLabel(item, name, collections)}</span>
}

export default function Page() {
  const hydrated = useAvi((state) => state.hydrated)
  const data = useAvi((state) => state.data)
  const page = useAvi((state) => state.page)
  const selectedId = useAvi((state) => state.selectedId)
  const toasts = useAvi((state) => state.toasts)
  const storageIssue = useAvi((state) => state.storageIssue)
  const setPage = useAvi((state) => state.setPage)
  const select = useAvi((state) => state.select)
  const capture = useAvi((state) => state.capture)
  const createCollection = useAvi((state) => state.createCollection)
  const editField = useAvi((state) => state.editField)
  const acceptField = useAvi((state) => state.acceptField)
  const acceptItems = useAvi((state) => state.acceptItems)
  const rejectField = useAvi((state) => state.rejectField)
  const deleteItems = useAvi((state) => state.deleteItems)
  const dismissToast = useAvi((state) => state.dismissToast)
  const undo = useAvi((state) => state.undo)

  const [view, setView] = useState<View>('room')
  const [libraryQuery, setLibraryQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [projectFilter, setProjectFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [reviewId, setReviewId] = useState<string | null>(null)
  const [commandOpen, setCommandOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [confirmedStamp, setConfirmedStamp] = useState<{ id: string; name?: string } | null>(null)
  const [citationNotice, setCitationNotice] = useState('')
  const [liveNotice, setLiveNotice] = useState('')
  const [saveText, setSaveText] = useState('')
  const [saveWhy, setSaveWhy] = useState('')
  const [saveFiles, setSaveFiles] = useState<File[]>([])
  const [newRoomName, setNewRoomName] = useState('')
  const [askQuery, setAskQuery] = useState('')
  const [savedNotice, setSavedNotice] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const saveRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [sketchOpen, setSketchOpen] = useState(false)
  const choseDefaultRoom = useRef(false)

  useEffect(() => {
    void useAvi.getState().hydrate()
  }, [])

  useEffect(() => {
    if (!hydrated || choseDefaultRoom.current) return
    choseDefaultRoom.current = true
    if (page === ALL_PAGE) {
      const aviRoom = data.collections.find((collection) => collection.name.toLowerCase().includes('avi'))
      if (aviRoom) setPage(aviRoom.id)
    }
  }, [data.collections, hydrated, page, setPage])

  useEffect(() => {
    if (commandOpen) searchRef.current?.focus()
  }, [commandOpen])

  useEffect(() => {
    if (saveOpen) saveRef.current?.focus()
  }, [saveOpen])

  const collections = data.collections
  const allItems = useMemo(() => liveItems(data).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [data])
  const roomItems = useMemo(() => itemsOnPage(data, page).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [data, page])
  const reviewItems = useMemo(() => allItems.filter(hasSuggestions), [allItems])
  const currentCollection = collections.find((collection) => collection.id === page)
  const featured = roomItems.find((item) => item.whyISavedThis?.trim()) ?? roomItems[0]
  const selectedItem = allItems.find((item) => item.id === selectedId)
  const reviewItem = reviewItems.find((item) => item.id === reviewId) ?? reviewItems[0]

  const filteredItems = useMemo(() => allItems.filter((item) => {
    const text = `${titleFor(item)} ${item.url ?? ''} ${item.rawContent} ${item.whyISavedThis ?? ''} ${summaryFor(item)}`.toLowerCase()
    if (libraryQuery.trim() && !text.includes(libraryQuery.trim().toLowerCase())) return false
    if (sourceFilter && sourceFor(item) !== sourceFilter) return false
    if (typeFilter && typeFor(item) !== typeFilter) return false
    if (projectFilter && item.fields.collection?.value !== projectFilter) return false
    if (tagFilter && !(item.fields.tags?.value ?? []).some((tag) => String(tag) === tagFilter)) return false
    return true
  }), [allItems, libraryQuery, sourceFilter, typeFilter, projectFilter, tagFilter])

  const sourceOptions = [...new Set(allItems.map(sourceFor))].sort()
  const typeOptions = [...new Set(allItems.map(typeFor))].sort()
  const roomSuggestionCount = roomItems.filter(hasSuggestions).length
  const selectedDetail = view === 'library'
    ? (selectedItem && filteredItems.some((item) => item.id === selectedItem.id) ? selectedItem : undefined)
    : selectedItem ?? (view === 'room' ? featured : undefined)
  const askResults = useMemo(() => {
    const query = askQuery.trim().toLowerCase()
    if (!query) return []
    return allItems.filter((item) => `${titleFor(item)} ${item.rawContent} ${item.whyISavedThis ?? ''} ${summaryFor(item)} ${(item.fields.tags?.value ?? []).join(' ')}`.toLowerCase().includes(query)).slice(0, 8)
  }, [allItems, askQuery])

  function formatCitation(item: Item): string {
    const title = titleFor(item)
    const url = item.url
    const note = item.whyISavedThis || item.fields.oneLineSummary?.value || item.rawContent
    if (url) {
      if (note && note !== title) {
        return `[${title}](${url})\n> "${note}"`
      }
      return `[${title}](${url})`
    }
    return `> "${note || title}"\n— ${title} (${relativeDate(item.createdAt)})`
  }

  async function copyCitation(item: Item) {
    const citation = formatCitation(item)
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(citation)
      } else if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea')
        textarea.value = citation
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'absolute'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCitationNotice(`Copied Markdown citation: ${titleFor(item)}`)
      setLiveNotice(`Copied citation for ${titleFor(item)} to clipboard`)
      window.setTimeout(() => setCitationNotice(''), 3000)
    } catch {
      setCitationNotice('Failed to copy citation')
      window.setTimeout(() => setCitationNotice(''), 3000)
    }
  }

  function triggerStamp(itemId: string, name?: string) {
    setConfirmedStamp({ id: itemId, name })
    window.setTimeout(() => {
      setConfirmedStamp((prev) => (prev?.id === itemId && prev?.name === name ? null : prev))
    }, 2200)
  }

  function confirmSuggestion(item: Item, name: FieldName) {
    acceptField(item.id, name)
    triggerStamp(item.id, name)
    setLiveNotice(`Confirmed ${name === 'oneLineSummary' ? 'summary' : name === 'collection' ? 'room' : 'tags'} for ${titleFor(item)}`)
  }

  function handleReject(item: Item, name: FieldName) {
    rejectField(item.id, name)
    setLiveNotice(`Skipped ${name === 'oneLineSummary' ? 'summary' : name === 'collection' ? 'room' : 'tags'} for ${titleFor(item)}`)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const activeEl = document.activeElement
      const isInput =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement ||
        Boolean(activeEl && (activeEl as HTMLElement).isContentEditable)

      if (event.key === 'Escape') {
        if (shortcutsOpen) {
          event.preventDefault()
          setShortcutsOpen(false)
          return
        }
        if (commandOpen) {
          event.preventDefault()
          setCommandOpen(false)
          return
        }
        if (saveOpen) {
          event.preventDefault()
          setSaveOpen(false)
          return
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((prev) => !prev)
        return
      }

      if (isInput) return

      if (event.key === '?' || (event.shiftKey && event.key === '/')) {
        event.preventDefault()
        setShortcutsOpen((prev) => !prev)
        return
      }

      if (event.key === '1') {
        event.preventDefault()
        setView('room')
        return
      }
      if (event.key === '2') {
        event.preventDefault()
        setView('review')
        if (reviewItems.length > 0 && !reviewId) setReviewId(reviewItems[0].id)
        return
      }
      if (event.key === '3') {
        event.preventDefault()
        setView('library')
        return
      }
      if (event.key === '4') {
        event.preventDefault()
        setView('ask')
        return
      }

      if (event.key.toLowerCase() === 'c') {
        const itemToCite = view === 'review' ? reviewItem : (selectedDetail ?? featured)
        if (itemToCite) {
          event.preventDefault()
          void copyCitation(itemToCite)
        }
        return
      }

      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        if (view === 'review') {
          if (reviewItems.length === 0) return
          const idx = reviewItems.findIndex((it) => it.id === reviewItem?.id)
          const nextIdx = (idx + 1) % reviewItems.length
          const nextItem = reviewItems[nextIdx]
          if (nextItem) {
            setReviewId(nextItem.id)
            select(nextItem.id)
            setLiveNotice(`Reviewing item ${nextIdx + 1} of ${reviewItems.length}: ${titleFor(nextItem)}`)
          }
        } else if (view === 'room') {
          if (roomItems.length === 0) return
          const idx = roomItems.findIndex((it) => it.id === selectedId)
          const nextIdx = (idx + 1) % roomItems.length
          const nextItem = roomItems[nextIdx]
          if (nextItem) {
            select(nextItem.id)
            setLiveNotice(`Selected ${titleFor(nextItem)}`)
          }
        } else if (view === 'library') {
          if (filteredItems.length === 0) return
          const idx = filteredItems.findIndex((it) => it.id === selectedId)
          const nextIdx = (idx + 1) % filteredItems.length
          const nextItem = filteredItems[nextIdx]
          if (nextItem) {
            select(nextItem.id)
            setLiveNotice(`Selected ${titleFor(nextItem)}`)
          }
        }
        return
      }

      if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (view === 'review') {
          if (reviewItems.length === 0) return
          const idx = reviewItems.findIndex((it) => it.id === reviewItem?.id)
          const prevIdx = (idx - 1 + reviewItems.length) % reviewItems.length
          const prevItem = reviewItems[prevIdx]
          if (prevItem) {
            setReviewId(prevItem.id)
            select(prevItem.id)
            setLiveNotice(`Reviewing item ${prevIdx + 1} of ${reviewItems.length}: ${titleFor(prevItem)}`)
          }
        } else if (view === 'room') {
          if (roomItems.length === 0) return
          const idx = roomItems.findIndex((it) => it.id === selectedId)
          const prevIdx = (idx - 1 + roomItems.length) % roomItems.length
          const prevItem = roomItems[prevIdx]
          if (prevItem) {
            select(prevItem.id)
            setLiveNotice(`Selected ${titleFor(prevItem)}`)
          }
        } else if (view === 'library') {
          if (filteredItems.length === 0) return
          const idx = filteredItems.findIndex((it) => it.id === selectedId)
          const prevIdx = (idx - 1 + filteredItems.length) % filteredItems.length
          const prevItem = filteredItems[prevIdx]
          if (prevItem) {
            select(prevItem.id)
            setLiveNotice(`Selected ${titleFor(prevItem)}`)
          }
        }
        return
      }

      if (event.key.toLowerCase() === 'a' || event.key === 'Enter') {
        if (view === 'review' && reviewItem) {
          event.preventDefault()
          const pendingField = REVIEW_FIELDS.find((name) => reviewItem.fields[name]?.state === 'suggested')
          if (pendingField) {
            confirmSuggestion(reviewItem, pendingField)
          }
        }
        return
      }

      if (event.key.toLowerCase() === 'x' || event.key === 'Delete') {
        if (view === 'review' && reviewItem) {
          event.preventDefault()
          const rejectableField = REVIEW_FIELDS.find((name) => reviewItem.fields[name]?.state === 'suggested' && REJECTABLE_FIELDS.includes(name))
          if (rejectableField) {
            handleReject(reviewItem, rejectableField)
          }
        }
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, reviewItem, reviewItems, roomItems, filteredItems, selectedId, selectedDetail, featured, shortcutsOpen, commandOpen, saveOpen, reviewId, select, acceptField, rejectField])

  function openLibraryFor(itemId?: string) {
    setView('library')
    if (itemId) select(itemId)
  }

  async function submitSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanText = saveText.trim()
    if (!cleanText && saveFiles.length === 0) return
    try {
      const ids = await capture({ text: cleanText, files: saveFiles, why: saveWhy.trim() })
      if (ids.length === 0) return
      setSavedNotice(ids.length === 1 ? 'Pinned to the sketchbook' : `${ids.length} scraps pinned to the sketchbook`)
      setSaveText('')
      setSaveWhy('')
      setSaveFiles([])
      if (fileRef.current) fileRef.current.value = ''
      setSaveOpen(false)
      window.setTimeout(() => setSavedNotice(''), 3200)
    } catch {
      setSavedNotice('Could not save that scrap. Your archive is unchanged.')
      window.setTimeout(() => setSavedNotice(''), 3200)
    }
  }

  function submitRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = createCollection(newRoomName)
    if (id) {
      setPage(id)
      setNewRoomName('')
    }
  }

  function chooseCommandResult(item: Item) {
    select(item.id)
    setView('library')
    setLibraryQuery('')
    setCommandOpen(false)
  }

  if (!hydrated) {
    return <main className="loading-shell"><div className="loading-mark" aria-hidden="true">AVI</div><p>Opening your archive</p></main>
  }

  return (
    <main className="avi-app">
      <header className="topbar">
        <a className="brand" href="#room" onClick={(event) => { event.preventDefault(); setView('room') }} aria-label="AVI home">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span className="brand-word">avi<span className="brand-period">.</span></span>
        </a>
        <nav className="primary-nav" aria-label="Main navigation">
          <button className={view === 'room' ? 'nav-link active' : 'nav-link'} type="button" onClick={() => setView('room')} aria-current={view === 'room' ? 'page' : undefined}>Room</button>
          <button className={view === 'review' ? 'nav-link active' : 'nav-link'} type="button" onClick={() => { setView('review'); setReviewId(reviewItems[0]?.id ?? null) }} aria-current={view === 'review' ? 'page' : undefined}>
            Review{reviewItems.length > 0 && <span className="nav-count">{reviewItems.length}</span>}
          </button>
          <button className={view === 'library' ? 'nav-link active' : 'nav-link'} type="button" onClick={() => setView('library')} aria-current={view === 'library' ? 'page' : undefined}>Library</button>
          <button className={view === 'ask' ? 'nav-link active' : 'nav-link'} type="button" onClick={() => setView('ask')} aria-current={view === 'ask' ? 'page' : undefined}>Ask</button>
        </nav>
        <div className="topbar-actions">
          <button className="shortcuts-trigger" type="button" onClick={() => setShortcutsOpen(true)} aria-label="Keyboard shortcuts, press question mark">
            <Keyboard size={15} aria-hidden="true" /><span>Keys</span><kbd>?</kbd>
          </button>
          <button className="search-trigger" type="button" onClick={() => setCommandOpen(true)} aria-label="Search AVI, control K">
            <Search size={16} aria-hidden="true" /><span>Search</span><kbd><Command size={11} aria-hidden="true" /> K</kbd>
          </button>
          <button className="save-button" type="button" onClick={() => setSaveOpen(true)}><Plus size={16} aria-hidden="true" /><span>Save a scrap</span></button>
        </div>
      </header>

      {storageIssue && <div className="storage-warning" role="status"><span>{storageIssue.message}</span><button type="button" onClick={() => useAvi.getState().openPanel('export')}>Export a copy</button></div>}

      <div className="workspace">
        <aside className="room-rail" aria-label="Project rooms">
          <div className="rail-label">Your rooms <span>{collections.length.toString().padStart(2, '0')}</span></div>
          <button className={`room-link${page === ALL_PAGE ? ' selected' : ''}`} type="button" onClick={() => setPage(ALL_PAGE)}>
            <span className="room-dot all-dot" aria-hidden="true" /><span>All saves</span><span className="room-count">{allItems.length}</span>
          </button>
          {collections.map((collection, index) => {
            const count = allItems.filter((item) => item.fields.collection?.value === collection.id).length
            return (
              <button className={`room-link${page === collection.id ? ' selected' : ''}`} type="button" onClick={() => setPage(collection.id)} key={collection.id} aria-current={page === collection.id ? 'page' : undefined}>
                <span className={`room-dot room-dot-${index % 3}`} aria-hidden="true" /><span className="room-name">{collection.name}</span><span className="room-count">{count}</span>
              </button>
            )
          })}
          <form className="room-create" onSubmit={submitRoom}>
            <label className="sr-only" htmlFor="new-room-name">New room name</label>
            <input id="new-room-name" value={newRoomName} onChange={(event) => setNewRoomName(event.target.value)} placeholder="New room name" maxLength={50} />
            <button type="submit" aria-label="Create room" disabled={!newRoomName.trim()}><Plus size={14} aria-hidden="true" /> Add room</button>
          </form>
          <div className="rail-footnote"><span className="local-indicator" />Saved on this device</div>
        </aside>

        <section className="main-pane">
          {view === 'room' && (
            <div className="view-content room-view">
              <nav className="mobile-room-picker" aria-label="Choose a room">
                <button className={page === ALL_PAGE ? 'selected' : ''} type="button" onClick={() => setPage(ALL_PAGE)}>All saves</button>
                {collections.map((collection) => <button className={page === collection.id ? 'selected' : ''} type="button" key={collection.id} onClick={() => setPage(collection.id)}>{collection.name}</button>)}
              </nav>
              <div className="view-kicker"><span>ROOM</span><span className="kicker-rule" /><span>{currentCollection?.name ?? 'All saves'}</span>{allItems.some((item) => item.origin === 'seed') && <span className="sample-flag">Illustrative sample data</span>}</div>
              <div className="room-heading-row">
                <div><h1>{currentCollection?.name ?? 'All saves'}</h1><p className="lede">A few things you kept close to this work.</p></div>
                <span className="save-count"><strong>{roomItems.length.toString().padStart(2, '0')}</strong> saves</span>
              </div>

              {featured ? (
                <>
                  <section className="recall-section" aria-labelledby="recall-heading">
                    <div className="section-label"><span className="signal-line" /><span>RELEVANT NOW</span><span className="section-note">From this room</span></div>
                    <article className="recall-card">
                      <span className="recall-side-note">{typeMark(typeFor(featured))}<span>{relativeDate(featured.createdAt)}</span></span>
                      <span className="recall-main">
                        <span className="recall-context"><Sparkles size={14} aria-hidden="true" /> {featured.whyISavedThis ? `You saved this for: ${featured.whyISavedThis}` : `Filed under ${currentCollection?.name ?? 'All saves'}`}</span>
                        <button className="recall-item-title" id="recall-heading" type="button" onClick={() => openLibraryFor(featured.id)}>{titleFor(featured)}</button>
                        <span className="recall-summary">{summaryFor(featured)}</span>
                        <span className="recall-footer">
                          <span>{sourceFor(featured)}</span>
                          {featured.url && <span className="recall-domain">{domainFor(featured.url)}</span>}
                          <button
                            className="citation-btn"
                            type="button"
                            onClick={(e) => {
                              void copyCitation(featured)
                            }}
                            aria-label="Copy citation as Markdown"
                          >
                            <Copy size={12} aria-hidden="true" />
                            <span>Copy citation</span>
                          </button>
                          <button className="recall-open" type="button" onClick={() => openLibraryFor(featured.id)}>View in library <ArrowUpRight size={14} aria-hidden="true" /></button>
                        </span>
                      </span>
                      <span className="recall-stamp" aria-hidden="true"><Bookmark size={20} strokeWidth={1.5} /><span>KEPT<br />FOR LATER</span></span>
                    </article>
                  </section>

                  <div className="room-lower-grid">
                    <section className="nearby-section" aria-labelledby="nearby-heading">
                      <div className="section-heading"><div><div className="section-label plain">THE ROOM</div><h2 id="nearby-heading">Nearby saves</h2></div><button className="text-action" type="button" onClick={() => openLibraryFor()} >Browse all <ArrowUpRight size={14} aria-hidden="true" /></button></div>
                      <div className="room-item-list">
                        {roomItems.filter((item) => item.id !== featured.id).slice(0, 5).map((item) => <ItemRow key={item.id} item={item} selected={selectedId === item.id} collections={collections} onSelect={() => select(item.id)} />)}
                        {roomItems.length <= 1 && <p className="inline-empty">This room is just getting started. Save a link or note to give it a little context.</p>}
                      </div>
                    </section>

                    <aside className="context-rail">
                      <div className="context-top"><span className="section-label plain">A SMALL REMINDER</span><span className="context-mark" aria-hidden="true">A</span></div>
                      <p className="context-quote">“{featured.whyISavedThis || summaryFor(featured)}”</p>
                      <p className="context-attribution">Your note on this save</p>
                      <div className="context-divider" />
                      <div className="context-stat"><span>Needs your eye</span><strong>{roomSuggestionCount.toString().padStart(2, '0')}</strong></div>
                      <button className="context-link" type="button" onClick={() => { setView('review'); setReviewId(reviewItems[0]?.id ?? null) }}>Review suggestions <ArrowDownRight size={15} aria-hidden="true" /></button>
                    </aside>
                  </div>
                </>
              ) : (
                <EmptyState title="Nothing in this room yet" text="Save a link or a note here. AVI will keep the context with it." action="Save something" onAction={() => setSaveOpen(true)} />
              )}
            </div>
          )}

          {view === 'review' && (
            <div className="view-content review-view">
              <div className="view-kicker"><span>REVIEW</span><span className="kicker-rule" /><span>{reviewItems.length} waiting for you</span></div>
              <div className="review-heading-row"><div><h1>Give these a quick look.</h1><p className="lede">AVI made a few suggestions. You decide what sticks.</p></div><span className="review-progress">{reviewItems.length ? 'Your call, always' : 'All clear'}</span></div>
              {reviewItem ? (
                <div className="review-layout">
                  <aside className="review-queue" aria-label="Items waiting for review">
                    <div className="queue-heading"><span>IN THE QUEUE</span><strong>{reviewItems.length.toString().padStart(2, '0')}</strong></div>
                    {reviewItems.map((item, index) => (
                      <button className={`queue-item${reviewItem.id === item.id ? ' active' : ''}`} type="button" key={item.id} onClick={() => { setReviewId(item.id); select(item.id) }} aria-current={reviewItem.id === item.id ? 'true' : undefined}>
                        <span className="queue-index">{String(index + 1).padStart(2, '0')}</span><span className="queue-copy"><strong>{titleFor(item)}</strong><small>{sourceFor(item)} · {relativeDate(item.createdAt).replace('Saved ', '')}</small></span><span className="queue-pip" />
                      </button>
                    ))}
                  </aside>
                  <article className="review-card">
                    <div className="review-card-top">
                      <span className="ai-badge"><Sparkles size={12} aria-hidden="true" /> AI-SUGGESTED</span>
                      <button
                        className="citation-btn"
                        type="button"
                        onClick={() => void copyCitation(reviewItem)}
                        aria-label="Copy citation as Markdown"
                      >
                        <Copy size={12} aria-hidden="true" />
                        <span>Copy citation</span>
                      </button>
                      <span className="review-item-date"><Clock3 size={13} aria-hidden="true" />{relativeDate(reviewItem.createdAt)}</span>
                    </div>
                    <div className="review-item-intro"><span className="item-mark large-mark" aria-hidden="true">{typeMark(typeFor(reviewItem))}</span><div><h2>{titleFor(reviewItem)}</h2><p>{summaryFor(reviewItem)}</p></div></div>
                    {reviewItem.url && <a className="source-url" href={reviewItem.url} target="_blank" rel="noreferrer"><Link2 size={14} aria-hidden="true" />{reviewItem.url}<ExternalLink size={13} aria-hidden="true" /></a>}
                    {reviewItem.whyISavedThis && <div className="saved-context"><span>YOUR NOTE</span><p>{reviewItem.whyISavedThis}</p></div>}

                    <div className="suggestion-heading"><div><span className="section-label plain">SUGGESTED DETAILS</span><p>Accept what fits. Edit anything else later.</p></div><span className="suggestion-count">{REVIEW_FIELDS.filter((name) => reviewItem.fields[name]?.state === 'suggested').length} fields</span></div>
                    <div className="suggestion-list">
                      {REVIEW_FIELDS.map((name) => {
                        const field = reviewItem.fields[name]
                        if (!field || field.state !== 'suggested') return null
                        const canReject = REJECTABLE_FIELDS.includes(name)
                        return (
                          <div className="suggestion-field" key={name}>
                            <div className="suggestion-field-head"><span>{name === 'oneLineSummary' ? 'Summary' : name === 'collection' ? 'Room' : 'Tags'}</span><span>{provenanceLabel(reviewItem, name)}</span></div>
                            <div className="suggestion-field-value"><FieldValue item={reviewItem} name={name} collections={collections} /></div>
                            <div className="suggestion-actions">
                              <button className="accept-action" type="button" onClick={() => confirmSuggestion(reviewItem, name)}><Check size={14} aria-hidden="true" />Keep suggestion <kbd>A</kbd></button>
                              {canReject && <button className="reject-action" type="button" onClick={() => handleReject(reviewItem, name)}><X size={14} aria-hidden="true" />Skip <kbd>X</kbd></button>}
                              {confirmedStamp?.id === reviewItem.id && confirmedStamp?.name === name && (
                                <span className="confirmed-stamp" role="status"><Check size={11} aria-hidden="true" />CONFIRMED</span>
                              )}
                            </div>
                          </div>
                        )
                      })}
                      {REVIEW_FIELDS.every((name) => reviewItem.fields[name]?.state !== 'suggested') && <div className="review-done"><Check size={17} aria-hidden="true" /><span>Nothing left to review for this save.</span><span className="confirmed-stamp" role="status">READY</span></div>}
                    </div>
                    <div className="review-card-foot"><span><Bookmark size={13} aria-hidden="true" /> Your saved content stays yours.</span><div className="review-stepper"><button type="button" onClick={() => { const index = reviewItems.findIndex((item) => item.id === reviewItem.id); setReviewId(reviewItems[(index - 1 + reviewItems.length) % reviewItems.length]?.id ?? null) }} aria-label="Previous review item"><ChevronLeft size={16} /></button><span>{String(reviewItems.findIndex((item) => item.id === reviewItem.id) + 1).padStart(2, '0')} / {String(reviewItems.length).padStart(2, '0')}</span><button type="button" onClick={() => { const index = reviewItems.findIndex((item) => item.id === reviewItem.id); setReviewId(reviewItems[(index + 1) % reviewItems.length]?.id ?? null) }} aria-label="Next review item"><ChevronRight size={16} /></button></div></div>
                    <button className="stamp-study" type="button" onClick={() => acceptItems([reviewItem.id])}><Check size={15} aria-hidden="true" /> Stamp this study</button>
                  </article>
                </div>
              ) : <EmptyState title="Nothing waiting for review" text="Your saved items are already filed. New suggestions will show up here when they are ready." action="Back to room" onAction={() => setView('room')} />}
            </div>
          )}

          {view === 'library' && (
            <div className="view-content library-view">
              <div className="view-kicker"><span>LIBRARY</span><span className="kicker-rule" /><span>Everything you kept</span></div>
              <div className="library-heading-row"><div><h1>A good place to look again.</h1><p className="lede">{allItems.length} saved things, held in their original context.</p></div><span className="library-index">AVI / ARCHIVE</span></div>
              <div className="library-toolbar">
                <label className="library-search"><Search size={16} aria-hidden="true" /><span className="sr-only">Search your library</span><input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Search a title, note, or link" /><kbd>Ctrl K</kbd></label>
                <div className="filter-row">
                  <label><span className="sr-only">Filter by project</span><select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="">All rooms</option>{collections.map((collection) => <option value={collection.id} key={collection.id}>{collection.name}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></label>
                  <label><span className="sr-only">Filter by source</span><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="">All sources</option>{sourceOptions.map((source) => <option value={source} key={source}>{source}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></label>
                  <label><span className="sr-only">Filter by type</span><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">All types</option>{typeOptions.map((type) => <option value={type} key={type}>{type}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></label>
                  <label><span className="sr-only">Filter by tag</span><select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">All tags</option>{TAXONOMY.map((tag) => <option value={tag.id} key={tag.id}>{tag.label}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></label>
                  {(libraryQuery || sourceFilter || typeFilter || projectFilter || tagFilter) && <button className="clear-filters" type="button" onClick={() => { setLibraryQuery(''); setSourceFilter(''); setTypeFilter(''); setProjectFilter(''); setTagFilter('') }}>Clear</button>}
                </div>
              </div>
              <div className="library-body">
                <section className="library-results" aria-label="Saved items">
                  <div className="result-count"><span>{filteredItems.length} {filteredItems.length === 1 ? 'result' : 'results'}</span><span>{filteredItems.length ? 'SORTED BY RECENT' : ''}</span></div>
                  {filteredItems.length ? filteredItems.map((item) => <ItemRow key={item.id} item={item} selected={selectedId === item.id} collections={collections} onSelect={() => select(item.id)} />) : <EmptyState title="No saves match that search" text="Try a different word or clear one of the filters." action="Clear filters" onAction={() => { setLibraryQuery(''); setSourceFilter(''); setTypeFilter(''); setProjectFilter(''); setTagFilter('') }} />}
                </section>
                <aside className="library-detail">
                  {selectedDetail ? <>
                    <div className="detail-eyebrow"><span>ITEM NOTE</span><span>{typeMark(typeFor(selectedDetail))}</span></div>
                    <h2>{titleFor(selectedDetail)}</h2>
                    <p className="detail-summary">{summaryFor(selectedDetail)}</p>
                    {selectedDetail.url && <a className="detail-open" href={selectedDetail.url} target="_blank" rel="noreferrer">Open original <ExternalLink size={14} aria-hidden="true" /></a>}
                    <div className="detail-rule" />
                    <div className="detail-field"><span>ROOM</span><strong>{collections.find((collection) => collection.id === selectedDetail.fields.collection?.value)?.name ?? 'Unfiled'}</strong></div>
                    <div className="detail-field"><span>SOURCE</span><strong>{sourceFor(selectedDetail)}</strong></div>
                    <div className="detail-field"><span>KEPT</span><strong>{relativeDate(selectedDetail.createdAt)}</strong></div>
                    <div className="detail-field detail-tags"><span>TAGS</span><FieldValue item={selectedDetail} name="tags" collections={collections} /></div>
                    {selectedDetail.whyISavedThis && <div className="detail-why"><span>WHY YOU KEPT IT</span><p>{selectedDetail.whyISavedThis}</p></div>}
                    <div className="detail-actions">
                      <button
                        className="citation-btn"
                        type="button"
                        onClick={() => void copyCitation(selectedDetail)}
                        aria-label="Copy Markdown citation"
                      >
                        <Copy size={13} aria-hidden="true" />
                        <span>Copy Markdown citation</span>
                      </button>
                      <button className="tear-action" type="button" onClick={() => { deleteItems([selectedDetail.id]); select(null) }}>Tear this scrap out</button>
                    </div>
                    {hasSuggestions(selectedDetail) && <button className="detail-review" type="button" onClick={() => { setReviewId(selectedDetail.id); setView('review') }}>Review suggestions <ArrowUpRight size={14} aria-hidden="true" /></button>}
                  </> : <div className="detail-placeholder"><FolderOpen size={22} strokeWidth={1.4} aria-hidden="true" /><span>Choose a save to see its context.</span></div>}
                </aside>
              </div>
            </div>
          )}

          {view === 'ask' && (
            <div className="view-content ask-view">
              <div className="view-kicker"><span>ASK THE ARCHIVE</span><span className="kicker-rule" /><span>Search your saved context</span></div>
              <div className="ask-heading"><div><h1>What were you keeping?</h1><p className="lede">Look through titles, notes, summaries, and tags in your local archive.</p></div><span className="sample-flag">Archive search</span></div>
              <label className="ask-search"><Search size={20} aria-hidden="true" /><span className="sr-only">Search your archive</span><input value={askQuery} onChange={(event) => setAskQuery(event.target.value)} placeholder="Try a phrase you remember…" /></label>
              {askQuery.trim() ? (
                <section className="ask-results" aria-live="polite" aria-label="Archive search results">
                  <div className="section-label plain">{askResults.length} {askResults.length === 1 ? 'SCRAP' : 'SCRAPS'} FOUND</div>
                  {askResults.length ? askResults.map((item) => <ItemRow key={item.id} item={item} selected={selectedId === item.id} collections={collections} onSelect={() => openLibraryFor(item.id)} />) : <p className="inline-empty">No saved scrap matches that phrase. Try a tag or the note you wrote when saving it.</p>}
                </section>
              ) : (
                <div className="ask-prompts">
                  <span className="section-label plain">START WITH A QUESTION</span>
                  {[
                    ['What did I save about design?', 'design'],
                    ['Find notes I kept for this project', 'project'],
                    ['Show my recent sketches', 'sketch'],
                  ].map(([prompt, query]) => <button className="ask-prompt" type="button" key={prompt} onClick={() => setAskQuery(query)}><Search size={14} aria-hidden="true" />{prompt}<ArrowUpRight size={14} aria-hidden="true" /></button>)}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <footer className="app-footer">
        <span>AVI <span className="brand-period">/</span> a memory for the things you keep</span>
        <div className="footer-actions">
          <button type="button" onClick={() => setShortcutsOpen(true)}>Shortcuts <kbd>?</kbd></button>
          <span className="footer-sep" aria-hidden="true">·</span>
          <button type="button" onClick={undo}>Undo last change</button>
        </div>
      </footer>

      <div className="sr-only" role="status" aria-live="polite">{liveNotice}</div>
      {citationNotice && <div className="saved-toast" role="status"><Check size={15} aria-hidden="true" />{citationNotice}</div>}
      {savedNotice && <div className="saved-toast" role="status"><Check size={15} aria-hidden="true" />{savedNotice}</div>}
      {toasts.map((toast) => <div className={`avi-toast ${toast.tone}`} role="status" key={toast.id}><span>{toast.message}</span>{toast.action && <button type="button" onClick={toast.action.run}>{toast.action.label}</button>}<button type="button" className="toast-close" onClick={() => dismissToast(toast.id)} aria-label="Dismiss notification"><X size={14} /></button></div>)}

      {shortcutsOpen && (
        <div className="modal-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShortcutsOpen(false) }}>
          <section className="shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
            <div className="shortcuts-head">
              <span id="shortcuts-title"><Keyboard size={18} aria-hidden="true" /> Desk shortcuts</span>
              <button type="button" onClick={() => setShortcutsOpen(false)} aria-label="Close shortcuts modal"><X size={16} /></button>
            </div>
            <p className="shortcuts-lede">Fast single-verb triage and review. No mouse needed.</p>
            <div className="shortcuts-grid">
              <div className="shortcuts-col">
                <span className="shortcuts-col-title">Triage & Review</span>
                <div className="shortcut-row">
                  <span>Next item</span>
                  <div className="shortcut-keys"><kbd>J</kbd> <span>or</span> <kbd>↓</kbd></div>
                </div>
                <div className="shortcut-row">
                  <span>Previous item</span>
                  <div className="shortcut-keys"><kbd>K</kbd> <span>or</span> <kbd>↑</kbd></div>
                </div>
                <div className="shortcut-row">
                  <span>Keep suggestion</span>
                  <div className="shortcut-keys"><kbd>A</kbd> <span>or</span> <kbd>↵</kbd></div>
                </div>
                <div className="shortcut-row">
                  <span>Skip suggestion</span>
                  <div className="shortcut-keys"><kbd>X</kbd></div>
                </div>
              </div>
              <div className="shortcuts-col">
                <span className="shortcuts-col-title">Desk & Navigation</span>
                <div className="shortcut-row">
                  <span>Copy Markdown citation</span>
                  <div className="shortcut-keys"><kbd>C</kbd></div>
                </div>
                <div className="shortcut-row">
                  <span>Switch view (1 / 2 / 3 / 4)</span>
                  <div className="shortcut-keys"><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></div>
                </div>
                <div className="shortcut-row">
                  <span>Quick search</span>
                  <div className="shortcut-keys"><kbd>Ctrl</kbd> <kbd>K</kbd></div>
                </div>
                <div className="shortcut-row">
                  <span>Toggle shortcuts</span>
                  <div className="shortcut-keys"><kbd>?</kbd></div>
                </div>
                <div className="shortcut-row">
                  <span>Close dialog</span>
                  <div className="shortcut-keys"><kbd>Esc</kbd></div>
                </div>
              </div>
            </div>
            <div className="shortcuts-foot">
              <span>Keystrokes are ignored when typing in search or notes.</span>
              <button className="quiet-button" type="button" onClick={() => setShortcutsOpen(false)}>Done</button>
            </div>
          </section>
        </div>
      )}

      {commandOpen && <div className="modal-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCommandOpen(false) }}><section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby="command-title"><div className="command-head"><span id="command-title">Find something you kept</span><button type="button" onClick={() => setCommandOpen(false)} aria-label="Close search"><X size={16} /></button></div><label className="command-input"><Search size={17} aria-hidden="true" /><span className="sr-only">Search saved items</span><input ref={searchRef} onChange={(event) => setLibraryQuery(event.target.value)} value={libraryQuery} placeholder="A title, a thought, a place…" /></label><div className="command-results">{allItems.filter((item) => `${titleFor(item)} ${item.rawContent} ${item.url ?? ''} ${item.whyISavedThis ?? ''}`.toLowerCase().includes(libraryQuery.toLowerCase())).slice(0, 6).map((item) => <button type="button" key={item.id} onClick={() => chooseCommandResult(item)}><span className="item-mark" aria-hidden="true">{typeMark(typeFor(item))}</span><span><strong>{titleFor(item)}</strong><small>{summaryFor(item)}</small></span><ArrowUpRight size={14} aria-hidden="true" /></button>)}{!allItems.some((item) => `${titleFor(item)} ${item.rawContent} ${item.url ?? ''} ${item.whyISavedThis ?? ''}`.toLowerCase().includes(libraryQuery.toLowerCase())) && <p className="command-empty">No saved items found. Try another phrase.</p>}</div><div className="command-foot"><span><kbd>ESC</kbd> close</span><span><kbd>TAB</kbd> move through results</span></div></section></div>}

      {saveOpen && <div className="modal-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSaveOpen(false) }}><section className="save-dialog sketch-paper" role="dialog" aria-modal="true" aria-labelledby="save-title"><div className="dialog-topline"><span>NEW SCRAP / {currentCollection?.name ?? 'ALL SAVES'}</span><button type="button" onClick={() => setSaveOpen(false)} aria-label="Close save dialog"><X size={17} /></button></div><h2 id="save-title">Pin something worth keeping.</h2><p className="dialog-copy">Save a link, a note, or a piece of work. AVI keeps it with your room.</p><form onSubmit={submitSave}><label className="save-label" htmlFor="save-content">Link or note</label><textarea ref={saveRef} id="save-content" value={saveText} onChange={(event) => setSaveText(event.target.value)} placeholder="Paste a link, quote, or thought…" rows={3} /><label className="save-label" htmlFor="save-why">Margin note <span>Why are you keeping it?</span></label><input id="save-why" value={saveWhy} onChange={(event) => setSaveWhy(event.target.value)} placeholder="The small thing you’ll forget later" /><div className="capture-tools"><input ref={fileRef} type="file" multiple accept="image/*,video/*,audio/*,.pdf,.txt,.md,.zip,.csv,.json" onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); if (selected.length) setSaveFiles((files) => [...files, ...selected]); event.currentTarget.value = '' }} aria-label="Choose image, video, audio, or document files" /><button className="quiet-button" type="button" onClick={() => fileRef.current?.click()}><Upload size={14} aria-hidden="true" /> Add files</button><button className="quiet-button" type="button" onClick={() => setSketchOpen((open) => !open)}><PenTool size={14} aria-hidden="true" /> {sketchOpen ? 'Close sketchpad' : 'Draw a scrap'}</button></div>{saveFiles.length > 0 && <p className="file-count">{saveFiles.length} {saveFiles.length === 1 ? 'file' : 'files'} ready: {saveFiles.map((file) => file.name).join(', ')}</p>}{sketchOpen && <SketchPadCapture onSave={(file) => setSaveFiles((files) => [...files, file])} />}<div className="dialog-actions"><button className="quiet-button" type="button" onClick={() => setSaveOpen(false)}>Cancel</button><button className="save-button" type="submit" disabled={!saveText.trim() && saveFiles.length === 0}><Plus size={15} aria-hidden="true" />Pin to room</button></div></form></section></div>}
    </main>
  )
}

function EmptyState({ title, text, action, onAction }: { title: string; text: string; action: string; onAction: () => void }) {
  return <div className="empty-state"><div className="empty-mark" aria-hidden="true"><FileText size={20} strokeWidth={1.4} /></div><h2>{title}</h2><p>{text}</p><button type="button" onClick={onAction}>{action}<ArrowUpRight size={14} aria-hidden="true" /></button></div>
}

function SketchPadCapture({ onSave }: { onSave: (file: File) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const [hasInk, setHasInk] = useState(false)

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return { x: ((event.clientX - rect.left) / rect.width) * canvas.width, y: ((event.clientY - rect.top) / rect.height) * canvas.height }
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    const at = point(event)
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !at) return
    drawingRef.current = true
    setHasInk(true)
    canvas.setPointerCapture(event.pointerId)
    ctx.beginPath()
    ctx.moveTo(at.x, at.y)
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return
    const ctx = canvasRef.current?.getContext('2d')
    const at = point(event)
    if (!ctx || !at) return
    ctx.strokeStyle = '#282925'
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineTo(at.x, at.y)
    ctx.stroke()
  }

  async function saveSketch() {
    const canvas = canvasRef.current
    if (!canvas || !hasInk) return
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (blob && blob.size > 120) onSave(new File([blob], `avi-sketch-${Date.now()}.png`, { type: 'image/png' }))
  }

  return <div className="sketchpad-wrap"><span className="save-label">Pencil study</span><canvas ref={canvasRef} width={900} height={300} aria-label="Draw a sketch to save into AVI" onPointerDown={start} onPointerMove={move} onPointerUp={() => { drawingRef.current = false }} onPointerCancel={() => { drawingRef.current = false }} /><div className="sketchpad-actions"><button type="button" onClick={() => { const ctx = canvasRef.current?.getContext('2d'); if (ctx) ctx.clearRect(0, 0, 900, 300); setHasInk(false) }}>Clear page</button><button type="button" onClick={() => void saveSketch()} disabled={!hasInk}>Add sketch to scrap</button></div></div>
}

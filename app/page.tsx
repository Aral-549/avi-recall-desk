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
  ExternalLink,
  FileText,
  FolderOpen,
  Link2,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { hasSuggestions, itemsOnPage, liveItems, useAvi } from '@/lib/avi/store'
import { tagLabel, TAXONOMY } from '@/lib/avi/taxonomy'
import { REJECTABLE_FIELDS, type FieldName, type Item, type ItemFields } from '@/lib/avi/types'

type View = 'room' | 'review' | 'library'

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
  const editField = useAvi((state) => state.editField)
  const rejectField = useAvi((state) => state.rejectField)
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
  const [saveText, setSaveText] = useState('')
  const [saveWhy, setSaveWhy] = useState('')
  const [savedNotice, setSavedNotice] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const saveRef = useRef<HTMLTextAreaElement>(null)
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen(true)
      }
      if (event.key === 'Escape') {
        setCommandOpen(false)
        setSaveOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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

  function openLibraryFor(itemId?: string) {
    setView('library')
    if (itemId) select(itemId)
  }

  function confirmSuggestion(item: Item, name: FieldName) {
    const field = item.fields[name]
    if (!field) return
    if (name === 'tags') editField(item.id, 'tags', field.value as ItemFields['tags']['value'])
    if (name === 'oneLineSummary') editField(item.id, 'oneLineSummary', field.value as string)
    if (name === 'collection') editField(item.id, 'collection', field.value as string | null)
  }

  function submitSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanText = saveText.trim()
    if (!cleanText) return
    void capture({ text: cleanText, why: saveWhy.trim() })
    setSavedNotice('Saved to this room')
    setSaveText('')
    setSaveWhy('')
    setSaveOpen(false)
    window.setTimeout(() => setSavedNotice(''), 3200)
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
        </nav>
        <div className="topbar-actions">
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
                    <button className="recall-card" type="button" onClick={() => openLibraryFor(featured.id)}>
                      <span className="recall-side-note">{typeMark(typeFor(featured))}<span>{relativeDate(featured.createdAt)}</span></span>
                      <span className="recall-main">
                        <span className="recall-context"><Sparkles size={14} aria-hidden="true" /> {featured.whyISavedThis ? `You saved this for: ${featured.whyISavedThis}` : `Filed under ${currentCollection?.name ?? 'All saves'}`}</span>
                        <strong id="recall-heading">{titleFor(featured)}</strong>
                        <span className="recall-summary">{summaryFor(featured)}</span>
                        <span className="recall-footer"><span>{sourceFor(featured)}</span>{featured.url && <span className="recall-domain">{domainFor(featured.url)}</span>}<span className="recall-open">View in library <ArrowUpRight size={14} aria-hidden="true" /></span></span>
                      </span>
                      <span className="recall-stamp" aria-hidden="true"><Bookmark size={20} strokeWidth={1.5} /><span>KEPT<br />FOR LATER</span></span>
                    </button>
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
                    <div className="review-card-top"><span className="ai-badge"><Sparkles size={12} aria-hidden="true" /> AI-SUGGESTED</span><span className="review-item-date"><Clock3 size={13} aria-hidden="true" />{relativeDate(reviewItem.createdAt)}</span></div>
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
                              <button className="accept-action" type="button" onClick={() => confirmSuggestion(reviewItem, name)}><Check size={14} aria-hidden="true" />Keep suggestion</button>
                              {canReject && <button className="reject-action" type="button" onClick={() => rejectField(reviewItem.id, name)}><X size={14} aria-hidden="true" />Skip</button>}
                            </div>
                          </div>
                        )
                      })}
                      {REVIEW_FIELDS.every((name) => reviewItem.fields[name]?.state !== 'suggested') && <div className="review-done"><Check size={17} aria-hidden="true" /><span>Nothing left to review for this save.</span></div>}
                    </div>
                    <div className="review-card-foot"><span><Bookmark size={13} aria-hidden="true" /> Your saved content stays yours.</span><div className="review-stepper"><button type="button" onClick={() => { const index = reviewItems.findIndex((item) => item.id === reviewItem.id); setReviewId(reviewItems[(index - 1 + reviewItems.length) % reviewItems.length]?.id ?? null) }} aria-label="Previous review item"><ChevronLeft size={16} /></button><span>{String(reviewItems.findIndex((item) => item.id === reviewItem.id) + 1).padStart(2, '0')} / {String(reviewItems.length).padStart(2, '0')}</span><button type="button" onClick={() => { const index = reviewItems.findIndex((item) => item.id === reviewItem.id); setReviewId(reviewItems[(index + 1) % reviewItems.length]?.id ?? null) }} aria-label="Next review item"><ChevronRight size={16} /></button></div></div>
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
                    {hasSuggestions(selectedDetail) && <button className="detail-review" type="button" onClick={() => { setReviewId(selectedDetail.id); setView('review') }}>Review suggestions <ArrowUpRight size={14} aria-hidden="true" /></button>}
                  </> : <div className="detail-placeholder"><FolderOpen size={22} strokeWidth={1.4} aria-hidden="true" /><span>Choose a save to see its context.</span></div>}
                </aside>
              </div>
            </div>
          )}
        </section>
      </div>

      <footer className="app-footer"><span>AVI <span className="brand-period">/</span> a memory for the things you keep</span><button type="button" onClick={undo}>Undo last change</button></footer>

      {savedNotice && <div className="saved-toast" role="status"><Check size={15} aria-hidden="true" />{savedNotice}</div>}
      {toasts.map((toast) => <div className={`avi-toast ${toast.tone}`} role="status" key={toast.id}><span>{toast.message}</span>{toast.action && <button type="button" onClick={toast.action.run}>{toast.action.label}</button>}<button type="button" className="toast-close" onClick={() => dismissToast(toast.id)} aria-label="Dismiss notification"><X size={14} /></button></div>)}

      {commandOpen && <div className="modal-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCommandOpen(false) }}><section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby="command-title"><div className="command-head"><span id="command-title">Find something you kept</span><button type="button" onClick={() => setCommandOpen(false)} aria-label="Close search"><X size={16} /></button></div><label className="command-input"><Search size={17} aria-hidden="true" /><span className="sr-only">Search saved items</span><input ref={searchRef} onChange={(event) => setLibraryQuery(event.target.value)} value={libraryQuery} placeholder="A title, a thought, a place…" /></label><div className="command-results">{allItems.filter((item) => `${titleFor(item)} ${item.rawContent} ${item.url ?? ''} ${item.whyISavedThis ?? ''}`.toLowerCase().includes(libraryQuery.toLowerCase())).slice(0, 6).map((item) => <button type="button" key={item.id} onClick={() => chooseCommandResult(item)}><span className="item-mark" aria-hidden="true">{typeMark(typeFor(item))}</span><span><strong>{titleFor(item)}</strong><small>{summaryFor(item)}</small></span><ArrowUpRight size={14} aria-hidden="true" /></button>)}{!allItems.some((item) => `${titleFor(item)} ${item.rawContent} ${item.url ?? ''} ${item.whyISavedThis ?? ''}`.toLowerCase().includes(libraryQuery.toLowerCase())) && <p className="command-empty">No saved items found. Try another phrase.</p>}</div><div className="command-foot"><span><kbd>ESC</kbd> close</span><span><kbd>TAB</kbd> move through results</span></div></section></div>}

      {saveOpen && <div className="modal-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSaveOpen(false) }}><section className="save-dialog" role="dialog" aria-modal="true" aria-labelledby="save-title"><div className="dialog-topline"><span>NEW SAVE</span><button type="button" onClick={() => setSaveOpen(false)} aria-label="Close save dialog"><X size={17} /></button></div><h2 id="save-title">Keep it with the work.</h2><p className="dialog-copy">Paste a link or leave yourself a note. AVI will file it in {currentCollection?.name ?? 'All saves'}.</p><form onSubmit={submitSave}><label className="save-label" htmlFor="save-content">Link or note</label><textarea ref={saveRef} id="save-content" value={saveText} onChange={(event) => setSaveText(event.target.value)} placeholder="Paste a link, quote, or thought…" rows={4} required /><label className="save-label" htmlFor="save-why">Why are you keeping it? <span>Optional</span></label><input id="save-why" value={saveWhy} onChange={(event) => setSaveWhy(event.target.value)} placeholder="The small thing you’ll forget later" /><div className="dialog-actions"><button className="quiet-button" type="button" onClick={() => setSaveOpen(false)}>Cancel</button><button className="save-button" type="submit"><Plus size={15} aria-hidden="true" />Save to room</button></div></form></section></div>}
    </main>
  )
}

function EmptyState({ title, text, action, onAction }: { title: string; text: string; action: string; onAction: () => void }) {
  return <div className="empty-state"><div className="empty-mark" aria-hidden="true"><FileText size={20} strokeWidth={1.4} /></div><h2>{title}</h2><p>{text}</p><button type="button" onClick={onAction}>{action}<ArrowUpRight size={14} aria-hidden="true" /></button></div>
}

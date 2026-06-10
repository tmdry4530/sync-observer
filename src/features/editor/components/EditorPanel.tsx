import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { EditorContent } from '@tiptap/react'
import { PresenceBar } from '../../presence/components/PresenceBar'
import type { ConnectionStatus } from '../../realtime/useConnectionStatus'
import type { DocumentMeta } from '../../../shared/types/contracts'
import { useYEditorRoom } from '../realtime/useYEditorRoom'
import { useCollaborativeEditor } from '../hooks/useCollaborativeEditor'
import { EditorKnowledgeRail } from './EditorKnowledgeRail'
import { filterSlashCommands, SlashCommandMenu, type SlashCommandItem } from './SlashCommandMenu'

interface SlashCommandState {
  query: string
  range: {
    from: number
    to: number
  }
}

const SLASH_MENU_STALE_MS = 6_000

interface EditorPanelProps {
  workspaceId: string
  documentId: string
  documentTitle?: string | undefined
  documents?: DocumentMeta[]
  hideStatus?: boolean
  variant?: 'default' | 'workbench'
  /** Spectator mode: render the document read-only (only agents edit). */
  readOnly?: boolean
  onStatusChange?: (status: ConnectionStatus) => void
}

export function EditorPanel({
  workspaceId,
  documentId,
  documentTitle,
  documents = [],
  hideStatus = false,
  variant = 'default',
  readOnly = false,
  onStatusChange
}: EditorPanelProps) {
  const isWorkbenchPane = variant === 'workbench'
  const realtime = useYEditorRoom(workspaceId, documentId)
  const editor = useCollaborativeEditor(realtime.doc, { editable: !readOnly })
  const status = realtime.status === 'disconnected' && realtime.presence.length > 0 ? 'connected' : realtime.status
  const [slashState, setSlashState] = useState<SlashCommandState | null>(null)
  const [activeSlashIndex, setActiveSlashIndex] = useState(0)
  const slashModeRef = useRef(false)
  const slashInputAtRef = useRef(0)
  const slashItems = useMemo(() => filterSlashCommands(slashState?.query ?? ''), [slashState?.query])

  useEffect(() => {
    onStatusChange?.(status)
  }, [onStatusChange, status])

  useEffect(() => {
    if (!editor) {
      setSlashState(null)
      return
    }

    const updateSlashState = () => {
      const { state } = editor
      const { selection } = state
      const isRecentSlashInput = Date.now() - slashInputAtRef.current < SLASH_MENU_STALE_MS
      if (!slashModeRef.current || !isRecentSlashInput || !editor.isFocused || !selection.empty) {
        slashModeRef.current = false
        setSlashState(null)
        return
      }

      const { $from } = selection
      const textBeforeCursor = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n')
      const slashMatch = /(?:^|\s)\/([A-Za-z0-9가-힣_-]*)$/.exec(textBeforeCursor)
      if (!slashMatch) {
        slashModeRef.current = false
        setSlashState(null)
        return
      }

      const slashIndex = textBeforeCursor.lastIndexOf('/')
      setSlashState({
        query: slashMatch[1] ?? '',
        range: {
          from: $from.start() + slashIndex,
          to: $from.pos
        }
      })
    }

    const clearSlashStateSoon = () =>
      window.setTimeout(() => {
        slashModeRef.current = false
        slashInputAtRef.current = 0
        setSlashState(null)
      }, 140)

    editor.on('update', updateSlashState)
    editor.on('selectionUpdate', updateSlashState)
    editor.on('blur', clearSlashStateSoon)

    return () => {
      editor.off('update', updateSlashState)
      editor.off('selectionUpdate', updateSlashState)
      editor.off('blur', clearSlashStateSoon)
    }
  }, [editor])

  useEffect(() => {
    setActiveSlashIndex(0)
  }, [slashState?.query])

  useEffect(() => {
    if (!slashState) return

    const remainingTime = Math.max(0, SLASH_MENU_STALE_MS - (Date.now() - slashInputAtRef.current))
    const timeoutId = window.setTimeout(() => {
      if (Date.now() - slashInputAtRef.current >= SLASH_MENU_STALE_MS) {
        slashModeRef.current = false
        slashInputAtRef.current = 0
        setSlashState(null)
      }
    }, remainingTime)

    return () => window.clearTimeout(timeoutId)
  }, [slashState])

  const runSlashCommand = useCallback(
    (item: SlashCommandItem) => {
      if (!editor || !slashState) return

      editor.chain().focus().deleteRange(slashState.range).run()
      item.run(editor)
      slashModeRef.current = false
      slashInputAtRef.current = 0
      setSlashState(null)
    },
    [editor, slashState]
  )

  const handleSlashKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing) {
        slashModeRef.current = true
        slashInputAtRef.current = Date.now()
      } else if (slashModeRef.current && !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing) {
        slashInputAtRef.current = Date.now()
      }

      if (!slashState || slashItems.length === 0 || event.nativeEvent.isComposing) return

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveSlashIndex((index) => (index + 1) % slashItems.length)
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveSlashIndex((index) => (index - 1 + slashItems.length) % slashItems.length)
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        const selectedItem = slashItems[activeSlashIndex] ?? slashItems[0]
        if (selectedItem) runSlashCommand(selectedItem)
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        slashModeRef.current = false
        slashInputAtRef.current = 0
        setSlashState(null)
      }
    },
    [activeSlashIndex, runSlashCommand, slashItems, slashState]
  )

  return (
    <section className={`editor-panel ${isWorkbenchPane ? 'editor-panel--workbench' : ''}`}>
      <header className={`panel-title ${isWorkbenchPane ? 'panel-title--workbench' : ''}`}>
        <div>
          {isWorkbenchPane ? null : <p className="eyebrow">문서</p>}
          <h1>{isWorkbenchPane ? '문서' : documentTitle ?? `문서 ${documentId.slice(0, 8)}`}</h1>
          {isWorkbenchPane ? null : <p className="editor-mode-hint">/ 명령 · [[문서링크]] · #태그</p>}
        </div>
        {hideStatus || isWorkbenchPane ? null : <span className={`status-pill ${status}`}>{status}</span>}
      </header>
      {isWorkbenchPane ? null : <PresenceBar states={realtime.presence} />}
      <div className="editor-workspace">
        <div className="editor-surface" onKeyDownCapture={handleSlashKeyDown}>
          {slashState ? (
            <SlashCommandMenu
              items={slashItems}
              activeIndex={activeSlashIndex}
              query={slashState.query}
              onSelect={runSlashCommand}
            />
          ) : null}
          <EditorContent editor={editor} />
        </div>
        <EditorKnowledgeRail editor={editor} workspaceId={workspaceId} documents={documents} />
      </div>
    </section>
  )
}

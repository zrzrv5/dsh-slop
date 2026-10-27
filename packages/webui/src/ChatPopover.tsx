import styles from './ChatStatus.module.css'
import { useEffect, useRef, type ReactNode } from 'react'

/** Anchored overlay with keyboard dismissal and focus restoration. */
export function ChatPopover({ label, close, children }: {
  label: string; close: () => void; children: ReactNode
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    const previous = document.activeElement
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.parentElement?.contains(event.target)) closeRef.current()
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeRef.current(); if (previous instanceof HTMLElement) previous.focus() }
    }
    document.addEventListener('pointerdown', pointer)
    document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', keyboard) }
  }, [])
  return <div ref={ref} className={styles['slop-chat-popover']} role="dialog" aria-label={label}>
    <header><strong>{label}</strong><button type="button" aria-label={`Close ${label}`} onClick={close}>×</button></header>
    {children}
  </div>
}

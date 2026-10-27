import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import clsx from 'clsx'

/** Shared body chrome matching the native Tool row's expanded card. */
export function ChatCard({ className, ...props }: ComponentPropsWithoutRef<'article'>): ReactNode {
  return <article {...props} className={clsx('slop-chat-card', className)} />
}

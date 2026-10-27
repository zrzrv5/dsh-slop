import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { SlopSettingsTabRegistry } from './settings-tabs.ts'
import { Tabs, tabElementIds } from './ui.tsx'

const ID_PREFIX = 'dsh-slop-settings'

/**
 * The single DSH-SLOP settings section: a tab strip over the tabs that the
 * enabled components registered. A tab whose component is disabled disappears;
 * if it was selected, the first remaining tab is shown instead.
 */
export function SlopSettings({ tabs }: { tabs: SlopSettingsTabRegistry }): ReactNode {
  const items = useSyncExternalStore(tabs.subscribe, tabs.snapshot, tabs.snapshot)
  const [selected, setSelected] = useState(tabs.selected)
  const active = items.find(tab => tab.id === selected) ?? items[0]

  const choose = (id: string): void => {
    tabs.selected = id
    setSelected(id)
  }
  // Remember the fallback so a later re-enable does not switch tabs under the user.
  useEffect(() => {
    if (selected !== undefined && active !== undefined && active.id !== selected) choose(active.id)
  })

  if (active === undefined) return null
  const ids = tabElementIds(ID_PREFIX, active.id)
  return <div className="slop-slot-surface slop-settings-tabs">
    <Tabs items={items.map(tab => ({ id: tab.id, label: tab.label }))} active={active.id} onChange={choose} ariaLabel="DSH-SLOP settings" idPrefix={ID_PREFIX} />
    <div key={active.id} role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} tabIndex={0} className="slop-settings-tabpanel">{active.render()}</div>
  </div>
}

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { SettingView, SettingsGroup, SettingsView } from '../protocol.js'
import { fetchSettings, saveSettings } from './api.js'

const SOURCE: Record<SettingView['source'], string> = {
  'env-file': 'set in .env',
  keychain: 'set in the keychain',
  shell: 'set in the environment the agent was started from',
  unset: 'not set',
}

/** The value a field starts from: a secret's is always blank, since the page never has it. */
const initial = (setting: SettingView) => (setting.kind === 'secret' ? '' : (setting.value ?? ''))

/**
 * One group of settings, saved on its own. Only what changed is sent: a
 * blank secret means "leave it", and removing a key is a separate, explicit
 * action rather than something an empty box can do by accident.
 */
function Group({ token, group, onSaved }: { token: string; group: SettingsGroup; onSaved: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(group.settings.map((setting) => [setting.name, initial(setting)])),
  )
  const [removing, setRemoving] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const changes: Record<string, string | null> = {}
  for (const setting of group.settings) {
    if (setting.source === 'shell') continue
    const draft = drafts[setting.name] ?? ''
    if (removing.has(setting.name)) changes[setting.name] = null
    else if (setting.kind === 'secret') {
      if (draft.trim()) changes[setting.name] = draft
    } else if (draft !== initial(setting)) {
      changes[setting.name] = draft === '' && setting.kind !== 'choice' ? null : draft
    }
  }
  const dirty = Object.keys(changes).length > 0

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!dirty) return
    setBusy(true)
    setError(null)
    const failure = await saveSettings(token, changes)
    setBusy(false)
    if (failure) return setError(failure)
    // Keys are not kept in the page a moment longer than it takes to send them.
    setDrafts((previous) =>
      Object.fromEntries(
        Object.entries(previous).map(([name, value]) => [
          name,
          group.settings.find((s) => s.name === name)?.kind === 'secret' ? '' : value,
        ]),
      ),
    )
    setRemoving(new Set())
    onSaved()
  }

  const set = (name: string, value: string) => setDrafts((previous) => ({ ...previous, [name]: value }))

  return (
    <form className="settings-group" onSubmit={(event) => void submit(event)} autoComplete="off">
      <h3>{group.title}</h3>
      <p className="muted">{group.description}</p>
      {group.settings.map((setting) => {
        const locked = setting.source === 'shell'
        const id = `setting-${setting.name}`
        return (
          <div key={setting.name} className="setting">
            <label htmlFor={id} className="setting__label">
              {setting.label} <code>{setting.name}</code>
            </label>
            {setting.kind === 'toggle' ? (
              <label className="setting__toggle">
                <input
                  id={id}
                  type="checkbox"
                  checked={drafts[setting.name] === '1'}
                  disabled={locked}
                  onChange={(event) => set(setting.name, event.target.checked ? '1' : '0')}
                />
                {drafts[setting.name] === '1' ? 'On' : 'Off'}
              </label>
            ) : setting.kind === 'choice' ? (
              <select
                id={id}
                value={drafts[setting.name]}
                disabled={locked}
                onChange={(event) => set(setting.name, event.target.value)}
              >
                {setting.options?.map((option) => (
                  <option key={option} value={option}>
                    {option || 'Off'}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                type={setting.kind === 'secret' ? 'password' : setting.kind === 'url' ? 'url' : 'text'}
                value={drafts[setting.name]}
                disabled={locked || removing.has(setting.name)}
                placeholder={
                  setting.kind === 'secret'
                    ? setting.source === 'unset'
                      ? 'Paste the key'
                      : 'Paste a new key to replace it'
                    : undefined
                }
                autoComplete={setting.kind === 'secret' ? 'new-password' : 'off'}
                spellCheck={false}
                onChange={(event) => set(setting.name, event.target.value)}
              />
            )}
            <div className="setting__meta">
              <span className={`setting__source setting__source--${setting.source}`}>{SOURCE[setting.source]}</span>
              {locked && <span> — change it there; .env cannot override it.</span>}
              {setting.kind === 'secret' && setting.source === 'env-file' && !locked && (
                <button
                  type="button"
                  className="link-button link-button--danger"
                  onClick={() =>
                    setRemoving((previous) => {
                      const next = new Set(previous)
                      if (next.has(setting.name)) next.delete(setting.name)
                      else next.add(setting.name)
                      return next
                    })
                  }
                >
                  {removing.has(setting.name) ? 'Keep it' : 'Remove'}
                </button>
              )}
              {setting.help && <span className="setting__help">{setting.help}</span>}
            </div>
          </div>
        )
      })}
      {error && <p className="error-text">{error}</p>}
      <button type="submit" className="button" disabled={!dirty || busy}>
        Save {group.title.toLowerCase()}
      </button>
    </form>
  )
}

export function SettingsPage({ token }: { token: string }) {
  const [view, setView] = useState<SettingsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped after a save, so each group starts again from what is now stored.
  const [generation, setGeneration] = useState(0)

  const load = useCallback(async () => {
    const result = await fetchSettings(token)
    if (typeof result === 'string') setError(result)
    else {
      setView(result)
      setGeneration((n) => n + 1)
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="page">
      <div className="page__head">
        <h2>Settings</h2>
      </div>
      {error && <p className="error-text">{error}</p>}
      {!view && !error && <p className="muted">Loading…</p>}
      {view && (
        <>
          <p className="muted">
            Saved to <code>{view.envPath}</code>, with keys{' '}
            {view.secretStore === '.env' ? (
              <>
                in that file (readable by you alone). Set <code>SECRET_STORE=keychain</code> to keep them in the OS
                keychain instead.
              </>
            ) : (
              <>in the {view.secretStore}.</>
            )}{' '}
            Keys are never shown again once saved. The shell, the sandbox and the file workspace are set with{' '}
            <code>open-agent init</code> or in <code>.env</code>.
          </p>
          {view.restartNeeded && (
            <div className="banner">
              Saved. The agent still runs with the settings it started with: restart <code>open-agent web</code> to use
              the new ones.
            </div>
          )}
          {view.groups.map((group) => (
            <Group key={`${group.id}:${generation}`} token={token} group={group} onSaved={() => void load()} />
          ))}
        </>
      )}
    </div>
  )
}

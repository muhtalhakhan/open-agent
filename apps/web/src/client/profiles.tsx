import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { ProfileAction, ProfileFields, ProfileTool, ProfileView, ProfilesView } from '../protocol.js'
import { changeProfiles, fetchProfiles } from './api.js'

const TOOLS: Array<{ tool: ProfileTool; label: string }> = [
  { tool: 'files', label: 'Files' },
  { tool: 'shell', label: 'Shell' },
  { tool: 'http', label: 'HTTP requests' },
  { tool: 'browser', label: 'Browser' },
  { tool: 'computer', label: 'Computer use' },
]

/** The tools a profile turns on that `.env` leaves off: what using it adds to the agent's reach. */
function widened(tools: ProfileFields['tools'], view: ProfilesView): ProfileTool[] {
  return TOOLS.map(({ tool }) => tool).filter((tool) => tools[tool] === true && !view.base.tools[tool])
}

type Choice = 'inherit' | 'on' | 'off'
const choiceOf = (enabled: boolean | undefined): Choice => (enabled === undefined ? 'inherit' : enabled ? 'on' : 'off')

/**
 * Creates a profile, or edits one of the person's own. A tool is on, off, or
 * left to `.env`; the restricted ones can be offered "on" only when the
 * profile already had them on, since the server refuses the page turning them on.
 */
function Editor({
  token,
  view,
  editing,
  onDone,
}: {
  token: string
  view: ProfilesView
  /** Absent for a new profile. */
  editing?: ProfileView
  onDone: (saved: boolean) => void
}) {
  const [id, setId] = useState(editing?.id ?? '')
  const [name, setName] = useState(editing?.name ?? '')
  const [model, setModel] = useState(editing?.model ?? view.base.model)
  const [tools, setTools] = useState<ProfileFields['tools']>(editing?.tools ?? {})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const failure = await changeProfiles(token, {
      action: 'save',
      id: id.trim(),
      create: !editing,
      profile: { name, model, tools },
    })
    setBusy(false)
    if (failure) return setError(failure)
    onDone(true)
  }

  const loosens = widened(tools, view)

  return (
    <form className="settings-group" onSubmit={(event) => void submit(event)} autoComplete="off">
      <h3>{editing ? `Edit ${editing.name}` : 'New profile'}</h3>
      <div className="setting">
        <label htmlFor="profile-id" className="setting__label">
          File name
        </label>
        <input
          id="profile-id"
          type="text"
          value={id}
          disabled={Boolean(editing)}
          spellCheck={false}
          placeholder="my-agent"
          onChange={(event) => setId(event.target.value)}
        />
        <div className="setting__meta">
          <span className="setting__help">
            What <code>--profile</code> takes. Letters, digits, ".", "_" and "-"; saved in <code>{view.dir}</code>.
          </span>
        </div>
      </div>
      <div className="setting">
        <label htmlFor="profile-name" className="setting__label">
          Name
        </label>
        <input id="profile-name" type="text" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="setting">
        <label htmlFor="profile-model" className="setting__label">
          Model
        </label>
        <input
          id="profile-model"
          type="text"
          value={model}
          spellCheck={false}
          onChange={(event) => setModel(event.target.value)}
        />
        <div className="setting__meta">
          <span className="setting__help">A model id the endpoint in your settings knows.</span>
        </div>
      </div>
      {TOOLS.map(({ tool, label }) => {
        const restricted = view.restricted.includes(tool)
        // Already on in the file: the page may keep it on, not turn it on.
        const canTurnOn = !restricted || view.base.tools[tool] || editing?.tools[tool] === true
        return (
          <div key={tool} className="setting">
            <label htmlFor={`profile-tool-${tool}`} className="setting__label">
              {label}
            </label>
            <select
              id={`profile-tool-${tool}`}
              value={choiceOf(tools[tool])}
              onChange={(event) => {
                const choice = event.target.value as Choice
                setTools((previous) => {
                  const next = { ...previous }
                  if (choice === 'inherit') delete next[tool]
                  else next[tool] = choice === 'on'
                  return next
                })
              }}
            >
              <option value="inherit">As in .env ({view.base.tools[tool] ? 'on' : 'off'})</option>
              <option value="on" disabled={!canTurnOn}>
                On
              </option>
              <option value="off">Off</option>
            </select>
            {!canTurnOn && (
              <div className="setting__meta">
                <span className="setting__help">
                  Turned on only in the profile file or in <code>.env</code>: it reaches the whole machine.
                </span>
              </div>
            )}
          </div>
        )
      })}
      {loosens.length > 0 && (
        <p className="banner">
          This profile turns on {loosens.join(', ')}, which <code>.env</code> leaves off.
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
      <div className="approval__actions">
        <button type="submit" className="button" disabled={busy || !id.trim() || !name.trim() || !model.trim()}>
          {editing ? 'Save' : 'Create'}
        </button>
        <button type="button" className="button button--secondary" disabled={busy} onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function ProfileRow({
  token,
  view,
  profile,
  onEdit,
  onChanged,
}: {
  token: string
  view: ProfilesView
  profile: ProfileView
  onEdit: () => void
  onChanged: () => void
}) {
  const [mode, setMode] = useState<'view' | 'duplicate' | 'delete'>('view')
  const [newId, setNewId] = useState(`${profile.id}-copy`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: ProfileAction) => {
    setBusy(true)
    setError(null)
    const failure = await changeProfiles(token, action)
    setBusy(false)
    if (failure) return setError(failure)
    setMode('view')
    onChanged()
  }

  const isDefault = view.defaultProfile?.id === profile.id
  const own = profile.origin === 'user'
  const loosens = widened(profile.tools, view)
  const set = TOOLS.filter(({ tool }) => profile.tools[tool] !== undefined)

  return (
    <li className="memory-row profile-row">
      <div className="profile-row__head">
        <strong>{profile.name}</strong>
        <code>{profile.id}</code>
        {!own && <span className="profile-badge">example</span>}
        {view.running === profile.id && <span className="profile-badge profile-badge--accent">running</span>}
        {isDefault && <span className="profile-badge profile-badge--accent">default</span>}
      </div>
      {profile.error ? (
        <p className="error-text">{profile.error}</p>
      ) : (
        <>
          <p className="profile-row__line">
            Model <code>{profile.model}</code>
          </p>
          <p className="profile-row__line">
            {set.length === 0
              ? 'Tools as in .env.'
              : set.map(({ tool, label }) => (
                  <span
                    key={tool}
                    className={`profile-tool ${profile.tools[tool] ? 'profile-tool--on' : ''} ${loosens.includes(tool) ? 'profile-tool--wider' : ''}`}
                    title={loosens.includes(tool) ? 'On here, off in .env' : undefined}
                  >
                    {label} {profile.tools[tool] ? 'on' : 'off'}
                  </span>
                ))}
          </p>
          {loosens.length > 0 && (
            <p className="profile-row__line profile-row__warning">
              Turns on {loosens.join(', ')}, which .env leaves off.
            </p>
          )}
        </>
      )}
      {mode === 'view' && (
        <div className="memory-row__meta">
          <span className="memory-row__actions">
            {!profile.error &&
              !view.defaultProfile?.locked &&
              (isDefault ? (
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => void run({ action: 'default', id: null })}
                >
                  Stop starting with it
                </button>
              ) : (
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => void run({ action: 'default', id: profile.id })}
                >
                  Start with this profile
                </button>
              ))}
            {own && !profile.error && (
              <button type="button" className="link-button" onClick={onEdit}>
                Edit
              </button>
            )}
            {!profile.error && (
              <button type="button" className="link-button" onClick={() => setMode('duplicate')}>
                Duplicate
              </button>
            )}
            {own && !isDefault && (
              <button type="button" className="link-button link-button--danger" onClick={() => setMode('delete')}>
                Delete
              </button>
            )}
          </span>
        </div>
      )}
      {mode === 'duplicate' && (
        <form
          className="approval__actions memory-row__confirm"
          onSubmit={(event) => {
            event.preventDefault()
            void run({ action: 'duplicate', id: profile.id, newId: newId.trim() })
          }}
        >
          <label htmlFor={`duplicate-${profile.id}`}>Copy as</label>
          <input
            id={`duplicate-${profile.id}`}
            type="text"
            value={newId}
            spellCheck={false}
            onChange={(event) => setNewId(event.target.value)}
          />
          <button type="submit" className="button" disabled={busy || !newId.trim()}>
            Duplicate
          </button>
          <button type="button" className="button button--secondary" disabled={busy} onClick={() => setMode('view')}>
            Cancel
          </button>
        </form>
      )}
      {mode === 'delete' && (
        <div className="approval__actions memory-row__confirm">
          <span>
            Delete <code>{profile.id}.yaml</code>? It cannot be brought back.
          </span>
          <button
            type="button"
            className="button button--stop"
            disabled={busy}
            onClick={() => void run({ action: 'delete', id: profile.id })}
          >
            Delete
          </button>
          <button type="button" className="button button--secondary" disabled={busy} onClick={() => setMode('view')}>
            Keep
          </button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </li>
  )
}

export function ProfilesPage({ token }: { token: string }) {
  const [view, setView] = useState<ProfilesView | null>(null)
  const [error, setError] = useState<string | null>(null)
  // `null` is the list; `'new'` or a profile id is the editor.
  const [editing, setEditing] = useState<string | null>(null)

  const load = useCallback(async () => {
    const result = await fetchProfiles(token)
    if (typeof result === 'string') setError(result)
    else {
      setError(null)
      setView(result)
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  const editProfile = editing && editing !== 'new' ? view?.profiles.find((p) => p.id === editing) : undefined

  return (
    <div className="page">
      <div className="page__head">
        <h2>Profiles</h2>
        {view && editing === null && (
          <button type="button" className="button button--secondary" onClick={() => setEditing('new')}>
            New profile
          </button>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
      {!view && !error && <p className="muted">Loading…</p>}
      {view && (
        <>
          <p className="muted">
            A profile sets the model and switches tools on or off over <code>.env</code>. Yours live in{' '}
            <code>{view.dir}</code>; the examples are read-only, so duplicate one to change it. The shell and computer
            tools can be turned off here, but turned on only in a profile file or in <code>.env</code>.
          </p>
          {view.defaultProfile?.locked && (
            <p className="muted">
              The profile to start with is set by <code>OPEN_AGENT_PROFILE</code> in the environment the agent was
              started from; change it there.
            </p>
          )}
          {view.restartNeeded && (
            <div className="banner">
              Saved. The agent still runs as it started: restart <code>open-agent web</code> to use the change.
            </div>
          )}
          {editing !== null ? (
            <Editor
              key={editing}
              token={token}
              view={view}
              editing={editProfile}
              onDone={(saved) => {
                setEditing(null)
                if (saved) void load()
              }}
            />
          ) : view.profiles.length === 0 ? (
            <p className="muted">No profiles yet.</p>
          ) : (
            <ul className="memory-list">
              {view.profiles.map((profile) => (
                <ProfileRow
                  key={`${profile.origin}:${profile.id}`}
                  token={token}
                  view={view}
                  profile={profile}
                  onEdit={() => setEditing(profile.id)}
                  onChanged={() => void load()}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

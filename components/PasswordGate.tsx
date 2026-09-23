'use client';

import { useState } from 'react';

// Full-screen password prompt shown until there is a valid session. The caller
// (useTrackSource.submitPassword) exchanges the password for a session token.
export default function PasswordGate({
  onSubmit,
  error,
  busy,
}: {
  onSubmit: (password: string) => void;
  error: string | null;
  busy: boolean;
}) {
  const [password, setPassword] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password && !busy) onSubmit(password);
  };

  return (
    <div className="overlay">
      <form className="panel" onSubmit={submit}>
        <h2>🔒 Password required</h2>
        <p className="hint">
          Enter the password to continue. You&apos;ll be asked again on this device after 7 days.
        </p>

        <div className="field">
          <label htmlFor="app-password">Password</label>
          <input
            id="app-password"
            type="password"
            value={password}
            placeholder="Enter password"
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        </div>

        {error && <div className="err-msg">{error}</div>}

        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={!password || busy}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </div>
      </form>
    </div>
  );
}

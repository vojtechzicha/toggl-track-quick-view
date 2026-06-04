'use client';

import { useState } from 'react';

// Full-screen gate shown when the deploy is password-protected and we don't
// hold a valid session yet. It only collects the password and hands it up; the
// password is never stored — page.tsx exchanges it for a session token.
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
          This dashboard is protected. Enter the password to view it. You&apos;ll only need to do
          this about once a week on this device.
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

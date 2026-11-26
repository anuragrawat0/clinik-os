'use client';

import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useHydrated } from '@/components/auth/use-hydrated';
import { Button } from '@/components/ui/button';
import { displayError } from '@/lib/api-client/problems';

export function Notice({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <p className={alert ? 'm1-notice m1-error' : 'm1-notice'} role={alert ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export function LoadError({ error }: { error: unknown }) {
  return <Notice alert>{displayError(error)}</Notice>;
}

export function Heading({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <header className="m1-heading">
      <h1>{title}</h1>
      {actions}
    </header>
  );
}

export function Unavailable() {
  return (
    <>
      <Heading title="Page not found" />
      <p className="m1-muted">This page is unavailable for your account.</p>
    </>
  );
}

export function textField(data: FormData, name: string): string {
  return String(data.get(name) ?? '').trim();
}

const timezones = ['UTC', ...Intl.supportedValuesOf('timeZone')];

export function Timezone({ initial = 'UTC' }: { initial?: string }) {
  return (
    <label className="m1-field">
      Time zone
      <select aria-label="Time zone" name="timezone" defaultValue={initial} required>
        {!timezones.includes(initial) && <option>{initial}</option>}
        {timezones.map((zone) => (
          <option key={zone}>{zone}</option>
        ))}
      </select>
    </label>
  );
}

export function FormDialog({
  title,
  submit,
  submitDisabled = false,
  onClose,
  action,
  children,
}: {
  title: string;
  submit: string;
  submitDisabled?: boolean;
  onClose: () => void;
  action: (values: FormData) => Promise<void>;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const hydrated = useHydrated();
  const mutation = useMutation({ mutationFn: action, onSuccess: onClose });
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="m1-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!mutation.isPending) onClose();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      <form
        className="m1-form"
        method="post"
        aria-busy={mutation.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          if (!hydrated || submitDisabled || mutation.isPending) return;
          mutation.mutate(new FormData(event.currentTarget));
        }}
      >
        <fieldset disabled={mutation.isPending}>{children}</fieldset>
        {mutation.isError && <LoadError error={mutation.error} />}
        <div className="m1-actions">
          <Button tone="quiet" type="button" disabled={mutation.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!hydrated || submitDisabled || mutation.isPending}>
            {submit}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

export function Confirm({
  title,
  message,
  submit,
  onClose,
  action,
}: {
  title: string;
  message: string;
  submit: string;
  onClose: () => void;
  action: () => Promise<void>;
}) {
  return (
    <FormDialog title={title} submit={submit} onClose={onClose} action={action}>
      <p>{message}</p>
    </FormDialog>
  );
}

export function LoadMore({
  load,
  busy,
  error,
}: {
  load: () => void;
  busy: boolean;
  error: unknown;
}) {
  return (
    <div className="m1-pagination">
      {error != null && <LoadError error={error} />}
      <Button tone="quiet" type="button" onClick={load} disabled={busy}>
        {busy ? 'Loading…' : 'Load more'}
      </Button>
    </div>
  );
}

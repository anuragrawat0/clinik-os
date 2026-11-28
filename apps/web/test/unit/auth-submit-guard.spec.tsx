import type { FormEvent, FormEventHandler } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { AuthForm } from '../../src/components/auth/auth-form';
import { InvitationForm } from '../../src/components/auth/invitation-form';

const hooks = vi.hoisted(() => ({
  mutateAsync: vi.fn<(values: FormData) => Promise<void>>(),
  submit: undefined as FormEventHandler<HTMLFormElement> | undefined,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('../../src/components/auth/use-hydrated', () => ({ useHydrated: () => true }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: hooks.mutateAsync, isPending: false }),
  useQueryClient: () => ({ clear: vi.fn() }),
  useQuery: () => ({
    data: { organizationName: 'Test Clinic', role: 'doctor', email: 'invite@example.test' },
  }),
}));

vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const runtime = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  // Capture the real submit handler while rendering without a browser DOM.
  const jsxDEV: typeof runtime.jsxDEV = (...args) => {
    const [type, props] = args;
    if (type === 'form') {
      hooks.submit = (props as { onSubmit?: FormEventHandler<HTMLFormElement> }).onSubmit;
    }
    return runtime.jsxDEV(...args);
  };
  return { ...runtime, jsxDEV };
});

it.each(['auth', 'invitation'])(
  'calls mutateAsync once when the %s form is submitted twice',
  (name) => {
    hooks.submit = undefined;
    hooks.mutateAsync.mockClear();
    let settle!: () => void;
    hooks.mutateAsync.mockReturnValue(new Promise<void>((resolve) => (settle = resolve)));

    renderToStaticMarkup(
      name === 'auth' ? <AuthForm mode="login" /> : <InvitationForm token="test-token" />,
    );
    const submit = hooks.submit as FormEventHandler<HTMLFormElement> | undefined;
    if (!submit) throw new Error('Expected a form submit handler');

    const event = { preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>;
    try {
      submit(event);
      submit(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(2);
      expect(hooks.mutateAsync).toHaveBeenCalledTimes(1);
      expect(hooks.mutateAsync).toHaveBeenCalledWith(expect.any(FormData));
    } finally {
      settle();
    }
  },
);

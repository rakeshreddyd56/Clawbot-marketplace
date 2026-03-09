/**
 * Test utilities — shared wrappers for React Testing Library renders.
 * Provides LocaleProvider context required by components using useLocale().
 */
import React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { LocaleProvider } from '../contexts/locale-context';

/**
 * Wrapper component that provides all required contexts for testing.
 */
function AllProviders({ children }: { children: React.ReactNode }) {
  return <LocaleProvider>{children}</LocaleProvider>;
}

/**
 * Custom render function that wraps components with all required providers.
 * Use this instead of @testing-library/react render() for components that
 * use useLocale() or other context hooks.
 */
function customRender(ui: React.ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return render(ui, { wrapper: AllProviders, ...options });
}

// Re-export everything from testing library
export * from '@testing-library/react';

// Override render with our custom version
export { customRender as render };
